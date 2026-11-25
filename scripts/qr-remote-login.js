/**
 * 远程扫码登录助手（手机操作版）：
 * 在本地 Mac（国内家宽 IP）打开登录页生成二维码 → 推送到企微群 →
 * 用户用「网易大神」App 扫码确认 → 本脚本检测登录成功 →
 * 自动导出凭证并更新云端 Secret，15 分钟内监控自动恢复。
 *
 * 用法：node scripts/qr-remote-login.js
 * 前置：本地 .env.local 文件（gitignored）内含 WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *       未配置 webhook 时，二维码保存到本地 qr-login.png（可在 WorkBuddy 会话里展示）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FORM_URL = 'https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_search_role_form';
const LOGIN_URL = 'https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login&area_id=48&area_name=%E6%B2%B3%E5%8C%972%E5%8C%BA&server_id=215&server_name=%E7%87%95%E8%B5%B5%E9%A3%8E%E4%BA%91';
// 区服参数来自 URL（页面 set_server_info() 读取）：area 48=河北2区，server 215=燕赵风云。
// 二维码登录在扫码确认后要求 server_id 非空，否则页面弹"请选择要登录的服务器"并中断会话建立（此前云端扫码失败的真正原因）。
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 读取本地配置（.env.local：KEY=VALUE 每行一条）
function loadEnvLocal() {
  const f = path.join(ROOT, '.env.local');
  if (!fs.existsSync(f)) return {};
  const out = {};
  fs.readFileSync(f, 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}
const ENV = loadEnvLocal();
const WEBHOOK = process.env.WECOM_WEBHOOK || ENV.WECOM_WEBHOOK || '';

const ts = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
function log(...a) { console.log(ts(), ...a); }

async function sendWecom(md) {
  if (!WEBHOOK) { log('（未配置 webhook，消息仅本地记录）', md.replace(/\n/g, ' | ')); return false; }
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
    });
    const j = await res.json().catch(() => ({}));
    log('通知发送:', j.errmsg || res.status);
    return j.errcode === 0;
  } catch (e) { log('通知发送失败:', e.message); return false; }
}

async function sendWecomImage(buf) {
  if (!WEBHOOK) { log('（未配置 webhook，二维码已保存到本地 qr-login.png）'); return false; }
  if (buf.length > 2 * 1024 * 1024) { log('图片超 2MB'); return false; }
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'image', image: { base64: buf.toString('base64'), md5: crypto.createHash('md5').update(buf).digest('hex') } }),
    });
    const j = await res.json().catch(() => ({}));
    log('图片通知发送:', j.errmsg || res.status);
    return j.errcode === 0;
  } catch (e) { log('图片通知失败:', e.message); return false; }
}

/** 定位二维码元素：img 或 canvas，近似正方形 120-320px */
async function locateQr(page) {
  for (const f of page.frames()) {
    const handles = await f.$$('img, canvas');
    for (const h of handles) {
      const ok = await h.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 120 && r.width < 320 && Math.abs(r.width - r.height) < 40;
      }).catch(() => false);
      if (ok) return { f, h };
    }
  }
  return null;
}

async function isLoggedIn(page) {
  const txt = await page.evaluate(() => {
    const el = document.querySelector('.userInfo');
    return el ? (el.innerText || '') : '';
  }).catch(() => '');
  return txt && !/梦幻玩家/.test(txt);
}

(async () => {
  log('启动远程扫码登录（本机国内网络，扫码确认不会被风控拦截）');
  if (!WEBHOOK) log('⚠️ 未配置 WECOM_WEBHOOK：二维码只保存到本地文件，请在 .env.local 中加入 WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx');

  let qrPollUrl = '';
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // ===== 诊断：记录全部非静态请求/响应（定位扫码确认后的会话建立回调） =====
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (/\.(png|jpg|jpeg|gif|css|woff2?|ico|svg)(\?|$)/i.test(u)) return;
      let body = '';
      try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200); } catch (e) { body = '(无法读取)'; }
      log('[net]', res.status(), u.slice(0, 130), '|', body);
    } catch (e) { /* 忽略 */ }
  });
  page.on('console', (msg) => { try { log('[console]', msg.type(), (msg.text() || '').slice(0, 150)); } catch (e) {} });
  page.on('pageerror', (err) => { try { log('[pageerror]', String(err).slice(0, 200)); } catch (e) {} });

  page.on('response', async (res) => {
    try {
      if (/get_login_qrcode/.test(res.url())) {
        const j = JSON.parse(await res.text());
        if (j.poll_url) qrPollUrl = j.poll_url;
      }
    } catch (e) { /* 忽略 */ }
  });

  log('打开登录页…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  for (const f of page.frames()) {
    await f.evaluate(() => {
      const el = [...document.querySelectorAll('a,span,div,li,dt,dd,p')].find((e) => /^二维码登录$/.test((e.textContent || '').trim()) && e.offsetParent !== null);
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => {});
  }
  await page.waitForTimeout(2500);

  let qr = await locateQr(page);
  if (!qr) { log('未找到二维码元素，退出'); await browser.close(); process.exit(1); }

  let qrSeq = 0;
  const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
  async function pushQr() {
    const png = await qr.h.screenshot();
    fs.writeFileSync(path.join(ROOT, 'qr-login.png'), png);
    qrSeq++;
    const ok = await sendWecomImage(png);
    if (ok) {
      await sendWecom(`📱 **本地登录二维码 #${qrSeq}（${stamp()} 推送）**\n⚠️ 只用「**网易大神**」App 扫一扫并确认，藏宝阁 App 和微信扫均无效。\n只扫**最新一张**；状态变化会实时通知`);
    } else {
      log('二维码已保存:', path.join(ROOT, 'qr-login.png'), '（请用手机扫描此图，或通过 WorkBuddy 会话查看）');
    }
    return png;
  }
  let lastPng = await pushQr();

  const deadline = Date.now() + 10 * 60 * 1000;
  let lastRet = '408';
  let lastQrCheck = Date.now();
  let success = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);

    // 登录成功检测：主页面跳离登录页 / 用户区变化
    if (page.url().indexOf('show_login') < 0) { success = true; break; }
    if (await isLoggedIn(page).catch(() => false)) { success = true; break; }

    // 直读扫码状态（与云端同源）：408=等待扫码，200=手机端已确认
    if (qrPollUrl) {
      const rt = await fetch(qrPollUrl + (qrPollUrl.indexOf('?') >= 0 ? '&' : '?') + 'callback=cb&t=' + Date.now(), { headers: { Referer: 'https://xyq.cbg.163.com/' } }).then((r) => r.text()).catch(() => '');
      const m = rt.match(/retCode["':\s]+(\d+)/);
      if (m && m[1] !== lastRet) {
        log('二维码状态变化:', lastRet, '→', m[1]);
        lastRet = m[1];
        if (m[1] === '200') {
          // 200=手机端已确认：立刻截图 + 记录 cookie + frame 文本（诊断会话建立断在哪一环）
          await page.waitForTimeout(4000);
          try {
            await page.screenshot({ path: path.join(ROOT, 'qr-after-200.png'), fullPage: false });
            log('已保存扫码确认后页面截图: qr-after-200.png');
            const cookies = await ctx.cookies();
            const interesting = cookies.filter((c) => /sess|token|login|ntes|cbg/i.test(c.name));
            log('当前 cookie（关键项）:', interesting.map((c) => c.name + '=' + String(c.value).slice(0, 12) + '…(域:' + c.domain + ')').join(' ; ') || '（无）');
            for (const f of page.frames()) {
              const t = await f.evaluate(() => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 150)).catch(() => '');
              if (t) log('[frame]', (f.url() || '').slice(0, 80), '|', t);
            }
          } catch (e) { log('诊断截图失败:', e.message); }
          await sendWecom('📲 **手机端已确认扫码**\n正在等待登录会话下发（本机国内网络，一般 10 秒内完成）…');
        } else if (m[1] !== '408') {
          await sendWecom(`📲 扫码状态变化（状态码 ${m[1]}，多为二维码已失效）。若未恢复，请扫下一张新码`);
        }
      }
    }

    // 二维码保鲜：每 45s 检查，过期自动点刷新并重推
    if (Date.now() - lastQrCheck > 45000) {
      lastQrCheck = Date.now();
      try {
        const st = await locateQr(page);
        if (!st) {
          log('二维码元素消失，检查登录状态…');
          if (await isLoggedIn(page).catch(() => false)) { success = true; break; }
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(3000);
          qr = await locateQr(page);
          if (!qr) { log('刷新后仍未找到二维码，退出'); break; }
          lastPng = await pushQr();
          continue;
        }
        const frameTxt = await st.f.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
        if (/过期|失效|刷新/.test(frameTxt)) {
          const clicked = await st.f.evaluate(() => {
            const el = [...document.querySelectorAll('a,span,div,p,i,em')].find((e) => /刷新/.test(e.textContent || '') && e.offsetParent !== null);
            if (el) { el.click(); return el.textContent.trim().slice(0, 20); }
            return '';
          }).catch(() => '');
          if (!clicked) await st.h.click().catch(() => {});
          log('检测到二维码过期，已点刷新');
          await page.waitForTimeout(2500);
        }
        const st2 = await locateQr(page);
        if (!st2) continue;
        const newPng = await st2.h.screenshot();
        if (Buffer.compare(lastPng, newPng) !== 0) {
          lastPng = newPng;
          qr = st2;
          await pushQr();
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  if (!success) {
    log('超时：10 分钟内未完成扫码');
    await sendWecom('⌛ **登录二维码未在有效期内扫码，本次放弃。**可重新触发推送，或双击桌面「刷新藏宝阁登录.command」人工登录');
    await browser.close();
    process.exit(1);
  }

  // 验证 + 导出 + 更新云端 Secret
  log('登录成功，验证并导出凭证…');
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const ok = await isLoggedIn(page);
  log('登录验证:', ok ? '通过' : '未通过');
  if (!ok) {
    await sendWecom('❌ 扫码已确认但登录验证未通过，请改用桌面「刷新藏宝阁登录.command」');
    await browser.close();
    process.exit(2);
  }
  const storage = await ctx.storageState();
  fs.writeFileSync(path.join(ROOT, 'session-state.json'), JSON.stringify(storage));
  await browser.close();

  // 上传 Secret（复用现有 upload-session.py）
  await new Promise((resolve) => {
    execFile('python3', [path.join(ROOT, 'scripts', 'upload-session.py')], { cwd: ROOT }, (err, stdout, stderr) => {
      log('上传 Secret:', err ? ('失败 ' + (err.message || '') + ' ' + (stderr || '')) : (stdout || 'ok').trim());
      resolve();
    });
  });

  await sendWecom('✅ **手机扫码登录成功，云端凭证已更新！**\n下一次监控运行（15 分钟内）将自动恢复搜索。');
  log('全部完成');
  process.exit(0);
})().catch((e) => { console.error('异常退出:', e.message); process.exit(1); });
