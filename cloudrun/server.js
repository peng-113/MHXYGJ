/**
 * 藏宝阁监控云托管服务（CloudBase Run）
 * - HTTP 服务监听 $PORT，定时器/手动请求 GET /run 触发一轮监控
 * - 低成本模式（最小实例 0）：无流量 30 分钟才缩容，一轮 2-10 分钟跑完绰绰有余
 * - 代码从 GitHub 仓库运行时拉取（monitor.js 更新后无需重新部署镜像）
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const REPO_DIR = '/app/repo';
const REPO_URL = process.env.REPO_URL || 'https://github.com/peng-113/MHXYGJ.git';
const PORT = process.env.PORT || 8080;

let busy = false;
let lastResult = { time: null, exit: null };

const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: '/app', stdio: 'inherit', env: process.env });
    p.on('exit', (c) => resolve(c));
    p.on('error', (e) => { log('spawn error:', e.message); resolve(-1); });
  });
}

async function ensureRepo() {
  if (fs.existsSync(REPO_DIR + '/.git')) return;
  log('克隆仓库…');
  await run('git', ['clone', REPO_URL, REPO_DIR]);
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
