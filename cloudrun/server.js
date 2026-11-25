/**
 * 藏宝阁监控云托管服务（CloudBase Run）
 * - HTTP 服务监听 $PORT，定时器/手动请求 GET /run 触发一轮监控
 * - 低成本模式（最小实例 0）：无流量 30 分钟才缩容，一轮 2-10 分钟跑完绰绰有余
 * - 代码从 GitHub 仓库运行时拉取（monitor.js 更新后无需重新部署镜像）
 * - GET /logs 返回最近运行日志（诊断用），GET /status 返回运行状态
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const REPO_DIR = '/app/repo';
const REPO_URL = process.env.REPO_URL || 'https://github.com/peng-113/MHXYGJ.git';
const PORT = process.env.PORT || 8080;
const LOG_BUF_MAX = 400;

let busy = false;
let lastResult = { time: null, exit: null };
const logBuf = [];

function pushLog(line) {
  const t = new Date().toISOString().slice(11, 19);
  logBuf.push(`[${t}] ${line}`);
  if (logBuf.length > LOG_BUF_MAX) logBuf.shift();
}

const log = (...a) => { const line = a.join(' '); console.log(line); pushLog(line); };

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: '/app', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(pushLog));
    p.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => pushLog('[stderr] ' + l)));
    p.on('exit', (c) => resolve(c));
    p.on('error', (e) => { log('spawn error:', e.message); resolve(-1); });
  });
}

async function ensureRepo() {
  if (fs.existsSync(REPO_DIR + '/.git')) return;
  log('克隆代码仓库…');
  const code = await run('git', ['clone', REPO_URL, REPO_DIR]);
  log('克隆结束，退出码', code);
}

async function doRound() {
  await ensureRepo();
  const code = await run('/bin/bash', ['/app/run.sh']);
  lastResult = { time: new Date().toISOString(), exit: code };
  log('本轮结束，退出码', code);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ busy, ...lastResult }));
  }
  if (url === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(logBuf.join('\n') || '(暂无日志)');
  }
  if (url === '/run' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (busy) { res.end('busy'); return; }
    busy = true;
    res.end('started');
    doRound().finally(() => { busy = false; });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => log('监控服务启动，监听端口', PORT));
