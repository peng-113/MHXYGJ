/**
 * 藏宝阁搜索监控（GitHub Actions 每 15 分钟运行）
 * 流程：读取 criteria.json 的启用方案 → Playwright 账密登录藏宝阁 →
 *       逐方案请求搜索接口 → 与 search-state.json 对比 → 新结果推企业微信群机器人
 * 环境变量：
 *   NETEASE_ACCOUNT / NETEASE_PASSWORD  网易账号密码（GitHub Secret）
 *   WECOM_WEBHOOK                        企业微信群机器人地址（GitHub Secret）
 *   DRY_RUN=1                            只测条件解析与 webhook，不登录不搜索
 * 退出码：0 正常（含"没有新结果"）；1 失败（登录失败等，同时会推送告警）
 */
const fs = require('fs');
const path = require('path');

const CRITERIA_FILE = path.join(__dirname, '..', 'criteria.json');
const PET_FILE = path.join(__dirname, '..', 'pet-criteria.json');
const WATCH_FILE = path.join(__dirname, '..', 'watch-list.json');
const STATE_FILE = path.join(__dirname, '..', 'search-state.json');
const SEARCH_URL = 'https://xyq.cbg.163.com/cgi-bin/recommend.py';
const SEARCH_TYPE = 'overall_search_role';
const HOME = 'https://xyq.cbg.163.com';
const FORM_URL = HOME + '/cgi-bin/xyq_overall_search.py?act=show_search_role_form';
// 登录恢复入口提示：登录必须本地完成（滑块验证），双击桌面的 .command 一键登录并自动更新云端凭证
const LOGIN_HINT = '\n👉 请在 Mac 上双击桌面「刷新藏宝阁登录.command」，在弹出的浏览器中完成登录，云端凭证会自动更新，监控 15 分钟内自动恢复。'
  + '\n[打开藏宝阁登录页](https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login)';

const ACCOUNT = process.env.NETEASE_ACCOUNT || '';
const PASSWORD = process.env.NETEASE_PASSWORD || '';
const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const SESSION_B64 = process.env.SESSION_STATE || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE_ACCOUNT_LOGIN = process.env.USE_ACCOUNT_LOGIN === '1'; // 强制账密登录模式（测试用）
const FORCE_QR_LOGIN = process.env.USE_QR_LOGIN === '1';           // 强制二维码登录模式（测试用）
const NEW_SESSION_FILE = path.join(__dirname, '..', 'new-session.b64'); // 扫码成功后导出新凭证，workflow 自动更新 Secret

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function sendWecom(md) {
  if (!WEBHOOK) {
    if (process.env.DEBUG_MD) log('DEBUG_MD 消息内容:\n' + md);
    log('未配置 WECOM_WEBHOOK，跳过通知'); return false;
  }
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
    });
    const j = await res.json().catch(() => ({}));
    log('通知发送:', j.errmsg || res.status);
    return j.errcode === 0;
  } catch (e) {
    log('通知发送失败:', e.message);
    return false;
  }
}

function loadJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function money(fen) {
  const n = Number(fen) / 100;
  return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(Math.round(n));
}

/** 搜索接口成功判定（实测成功返回 status:1 / status_code:OK） */
function isOk(res) {
  return res && (res.status_code === 'OK' || res.status === 0 || res.status === 1);
}

/** 同类告警 N 小时内只发一次（循环模式下防止刷屏），状态持久化到状态文件 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ seen: state.seen, alerts: state.alerts, watch: state.watch || {}, digestDate: state.digestDate, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

async function alertOnce(state, key, hours, msg) {
  const last = state.alerts[key] || 0;
  if (Date.now() - last < hours * 3600e3) { log('告警冷却中，跳过:', key); return; }
  state.alerts[key] = Date.now();
  saveState(state);
  await sendWecom(msg); // 必须等推送完成：调用方常紧随 process.exit，不等待会把消息杀在半路
}

function resultLine(r) {
  const name = r.equip_name || r.name || '未知角色';
  // 金额按实际售价精确显示（price_desc 为官方标价，如 "14850.00"）
  let price = money(r.price);
  if (r.price_desc) {
    const p = Number(r.price_desc);
    price = (Number.isInteger(p) ? p.toLocaleString('en-US') : r.price_desc) + '元';
  }
  const server = [r.area_name, r.server_name].filter(Boolean).join('-');
  const level = r.level_desc || (r.level != null ? r.level + '级' : '');
  // 电脑版藏宝阁原网址：equip_detail.py 不会按 UA 跳转到微信手机页（企微内可直接打开）
  const url = `${HOME}/cgi-bin/equip_detail.py?s=${r.serverid || r.server_id || ''}&eid=${r.eid}&client_type=web&o`;
  let line = `**${name}**（${level}） ${price} ${server}`;
  if (r.desc_sumup) line += `\n> ${r.desc_sumup}`;
  else if (r.highlight) {
    const hl = Array.isArray(r.highlight) ? r.highlight.map((h) => h.name || h).join(' / ') : String(r.highlight);
    if (hl) line += '\n> ' + hl.slice(0, 80);
  }
  line += `\n[查看详情](${url})`;
  return line;
}

/** 用已登录的浏览器上下文请求一次搜索（JSONP） */
async function searchOnce(ctx, criteria, pageNo, searchType) {
  const qs = new URLSearchParams();
  qs.set('act', 'recommd_by_role');
  qs.set('search_type', searchType || SEARCH_TYPE);
  qs.set('page', String(pageNo || 1));
  qs.set('count', '15');
  qs.set('_', String(Date.now()));
  Object.keys(criteria || {}).forEach((k) => qs.set(k, criteria[k]));
  const url = `${SEARCH_URL}?callback=cb&${qs.toString()}`;
  // 用 Playwright 请求层（自动携带上下文 cookies，比页面内 fetch 稳定）
  const resp = await ctx.request.get(url, { headers: { Referer: FORM_URL } });
  const text = await resp.text();
  const m = text.match(/^\w+\(([\s\S]*)\)\s*$/);
  if (!m) throw new Error('响应不是 JSONP：HTTP ' + resp.status() + ' ' + text.slice(0, 120));
  return JSON.parse(m[1]);
}

/** 检查登录态（页面顶部是否出现"退出"） */
async function isLoggedIn(page) {
  return page.evaluate(() => /退出登录|>退出<|切换角色/.test(document.body.innerText));
}

/** 解析藏宝阁详情链接（PC 与手机版格式）→ { serverid, eid } */
function parseEquipUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  const m = u.match(/\/cgi\/mweb\/equip\/(\d+)\/([A-Za-z0-9_-]+)/);
  if (m) return { serverid: m[1], eid: m[2] };
  try {
    const q = new URL(u, 'https://xyq.cbg.163.com').searchParams;
    const eid = q.get('eid');
    const serverid = q.get('s') || q.get('serverid');
    if (eid && serverid) return { serverid: String(serverid), eid: String(eid) };
  } catch (e) { /* 非法链接 */ }
  return null;
}

/** 解析电脑版详情页 HTML 中内嵌的 var equip = {...} 数据 */
function parseEquipDetailHtml(html) {
  const i = html.indexOf('var equip = {');
  if (i < 0) return null;
  const end = html.indexOf('</script>', i);
  const seg = html.slice(i, end > 0 ? end : i + 8000);
  const get = (key) => {
    const m = seg.match(new RegExp('"' + key + '"\\s*:\\s*(?:"([^"]*)"|\'([^\']*)\'|(-?[\\d.]+))'));
    if (!m) return undefined;
    return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  };
  const priceYuan = parseFloat(get('price'));
  return {
    equip_name: get('equip_name') || '',
    price: Number.isFinite(priceYuan) && priceYuan > 0 ? Math.round(priceYuan * 100) : 0, // 元 → 分
    is_selling: get('is_selling'),
    expire_time_desc: get('expire_time_desc') || '',
  };
}

/** 查询单条链接的当前售价（电脑版详情页，与搜索同域、直接复用登录凭证） */
async function fetchWatchPrice(ctx, item) {
  const resp = await ctx.request.get(`${HOME}/cgi-bin/equip_detail.py?s=${item.serverid}&eid=${encodeURIComponent(item.eid)}&client_type=web&o`, {
    headers: { Referer: HOME + '/' },
  });
  if (resp.status() === 302 || resp.status() === 303) throw new Error('详情页跳转登录（凭证失效）');
  // 页面为 GBK 编码，需按字节解码
  const buf = await resp.body();
  let html;
  try { html = new TextDecoder('gbk').decode(buf); } catch (e) { html = buf.toString('utf8'); }
  const equip = parseEquipDetailHtml(html);
  if (!equip) throw new Error('详情页解析失败（HTTP ' + resp.status() + '）');
  return equip;
}

/** 账密登录（登录页 show_login.py?act=show_login，网易统一登录 iframe：dl.reg.163.com） */
async function findPassFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    // 只认"当前可见"的账号/密码输入框（隐藏 tab 里的同名输入框不算）
    const has = await f.evaluate(() => {
      const vis = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
      const u = document.querySelector('input[name=email]');
      const p = document.querySelector('input[name=password]');
      return vis(u) || vis(p);
    }).catch(() => false);
    if (has) return f;
  }
  return null;
}

async function doLogin(page) {
  log('打开登录页…');
  await page.goto(HOME + '/cgi-bin/show_login.py?act=show_login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  let target = await findPassFrame(page);
  // 默认可能是"二维码登录"标签，先点"邮箱登录"切到账密表单
  if (!target) {
    log('未见密码表单，尝试点击"邮箱登录"标签…');
    for (const f of page.frames()) {
      const tab = await f.evaluate(() => {
        const els = [...document.querySelectorAll('a,span,div,li,dt,dd,p')];
        const el = els.find((e) => /^(邮箱登录|网易邮箱账号登录)$/.test((e.textContent || '').trim()) && e.offsetParent !== null);
        if (el) { el.click(); return el.tagName + '.' + el.className; }
        return '';
      }).catch(() => '');
      if (tab) { log('已点击标签:', tab); break; }
    }
    await page.waitForTimeout(2500);
    target = await findPassFrame(page);
  }
  if (!target) {
    const dbg = await page.evaluate(() => ({
      url: location.href, title: document.title,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    })).catch(() => ({}));
    const frameUrls = page.frames().map((f) => f.url()).join(' | ');
    throw new Error('没找到登录输入框。页面: ' + (dbg.url || '?') + ' | 文本: ' + (dbg.text || '') + ' | frames: ' + frameUrls);
  }
  log('在登录 iframe 中填写账号');
  const userInput = await target.$('input[name=email]');
  if (!userInput) throw new Error('没找到账号输入框');
  await userInput.fill('');
  await userInput.type(ACCOUNT, { delay: 60 });
  await page.waitForTimeout(800);
  const passInput = await target.$('input[name=password]');
  await passInput.fill('');
  await passInput.type(PASSWORD, { delay: 60 });
  await page.waitForTimeout(500);
  // 提交：优先明确的登录按钮（网易统一登录按钮可能是 a/button/input）
  const clicked = await target.evaluate(() => {
    const cands = [
      ...document.querySelectorAll('#loginbtn, .js-login, input[type=submit], a.loginbtn, button, a, div[class*=loginbtn], a[class*=login]'),
    ];
    const el = cands.find((b) => /^(登\s*录|登录)$/.test((b.value || b.textContent || '').trim()) && b.offsetParent !== null);
    if (el) { el.click(); return el.tagName + '.' + el.className; }
    return '';
  });
  log('提交登录:', clicked || '未找到按钮');
  await page.waitForTimeout(12000);
  // 诊断：登录后各 frame 的提示/报错文本（判断是密码错误、滑块验证还是风控拦截）
  const diagTexts = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 150)).catch(() => '');
    if (t) diagTexts.push('[' + f.url().slice(-45) + '] ' + t);
  }
  log('登录后各区域文本:', diagTexts.join(' || ').slice(0, 700) || '(全部为空)');
  // 回到藏宝阁主页验证（SSO 跳转可能滞后，验证两次）
  for (let round = 0; round < 2; round++) {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const ok = await isLoggedIn(page);
    const userInfo = await page.evaluate(() => {
      const el = document.querySelector('.userInfo') || document.body;
      return (el.innerText || '').replace(/\s+/g, ' ').slice(0, 80);
    }).catch(() => '');
    log('登录结果:', ok ? '成功' : '失败', '| 用户区文本:', userInfo);
    if (ok) return true;
    await page.waitForTimeout(4000);
  }
  return false;
}

(async () => {
  const criteriaData = loadJson(CRITERIA_FILE, null);
  if (!criteriaData || !Array.isArray(criteriaData.schemes)) {
    console.error('criteria.json 缺失或格式错误'); process.exit(1);
  }
  const enabled = criteriaData.schemes.filter((s) => s.enabled);
  const petData = loadJson(PET_FILE, null);
  const petEnabled = (petData && Array.isArray(petData.schemes)) ? petData.schemes.filter((s) => s.enabled) : [];
  const watchData = loadJson(WATCH_FILE, null);
  const watchItems = (watchData && Array.isArray(watchData.items)) ? watchData.items.filter((i) => i.enabled && i.serverid && i.eid) : [];
  log(`共 ${criteriaData.schemes.length} 个角色方案（启用 ${enabled.length}），${petData ? petData.schemes.length : 0} 个召唤兽方案（启用 ${petEnabled.length}），${watchData ? watchData.items.length : 0} 条监控链接（启用 ${watchItems.length}）`);

  const state = loadJson(STATE_FILE, { seen: {} });
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  // seen 结构：{ [seenKey]: { [game_ordersn]: 上次售价(分) } }；旧版为数组，迁移为对象（价格未知记 0，不触发降价提醒）
  Object.keys(state.seen).forEach((k) => {
    if (Array.isArray(state.seen[k])) {
      const m = {};
      state.seen[k].forEach((sn) => { m[sn] = 0; });
      state.seen[k] = m;
    }
  });
  // 修正历史双前缀键：pet_pet_xxx → pet_xxx
  Object.keys(state.seen).forEach((k) => {
    if (k.indexOf('pet_pet_') === 0) {
      state.seen['pet_' + k.slice(8)] = state.seen[k];
      delete state.seen[k];
    }
  });
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};

  if (DRY_RUN) {
    enabled.forEach((s) => log('角色方案', s.name, '条件:', JSON.stringify(s.criteria)));
    petEnabled.forEach((s) => log('召唤兽方案', s.name, '条件:', JSON.stringify(s.criteria)));
    watchItems.forEach((i) => log('监控链接', i.name || i.eid, 'serverid:', i.serverid, '阈值:', i.threshold + '%'));
    await sendWecom('🧪 **搜索监控 DRY-RUN 测试**\n链路连通，webhook 正常。\n启用角色方案数：' + enabled.length + '，召唤兽方案数：' + petEnabled.length + '，监控链接数：' + watchItems.length);
    process.exit(0);
  }

  if (!enabled.length && !petEnabled.length && !watchItems.length) { log('没有启用的方案或链接，结束'); process.exit(0); }
  if (!SESSION_B64 && (!ACCOUNT || !PASSWORD)) {
    // 既无凭证也无账密时静默跳过，避免定时任务反复报错；配置后自动开始工作
    log('未设置 SESSION_STATE / NETEASE_ACCOUNT / NETEASE_PASSWORD，跳过本次运行');
    process.exit(0);
  }

  let { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 选一个探测用方案：优先角色方案，否则召唤兽方案 */
function pickProbe() {
  if (enabled.length) return { criteria: enabled[0].criteria, type: SEARCH_TYPE };
  if (petEnabled.length) return { criteria: petEnabled[0].criteria, type: 'overall_search_pet' };
  return null;
}

/** 临时图床上传（免密钥）：返回公网图片 URL，全部失败返回 '' */
async function uploadImage(buf) {
  // 首选 sm.ms 匿名上传（国内可达性较好）
  try {
    const fd = new FormData();
    fd.append('smfile', new Blob([buf]), 'qrcode.png');
    const res = await fetch('https://sm.ms/api/v2/upload', { method: 'POST', body: fd });
    const j = await res.json();
    if (j.success && j.data && j.data.url) return j.data.url;
    log('sm.ms 上传响应:', JSON.stringify(j).slice(0, 200));
  } catch (e) { log('sm.ms 上传异常:', e.message); }
  // 备选 tmpfiles.org（保留 1 小时，够扫码用）
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'qrcode.png');
    const res = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd });
    const j = await res.json();
    if (j && j.data && j.data.url) return j.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
  } catch (e) { log('tmpfiles 上传异常:', e.message); }
  return '';
}

/** 扫码登录成功后的验证与新凭证导出（workflow 会自动更新 SESSION_STATE Secret） */
async function verifyAndExport(ctx, page) {
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const ok = await isLoggedIn(page);
  log('扫码登录验证:', ok ? '成功' : '失败');
  if (!ok) return false;
  const storage = await ctx.storageState();
  fs.writeFileSync(NEW_SESSION_FILE, Buffer.from(JSON.stringify(storage), 'utf8').toString('base64'));
  log('新凭证已导出到 new-session.b64，workflow 将自动更新云端 Secret');
  return true;
}

/** 二维码扫码登录自愈：生成登录二维码 → 推送到企微 → 等用户手机扫码（最长 3.5 分钟） */
async function tryQrLogin(ctx, page) {
  log('打开登录页（二维码模式）…');
  await page.goto(HOME + '/cgi-bin/show_login.py?act=show_login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // 确保二维码登录 tab 激活（页面默认通常已是）
  for (const f of page.frames()) {
    await f.evaluate(() => {
      const el = [...document.querySelectorAll('a,span,div,li,dt,dd,p')].find((e) => /^二维码登录$/.test((e.textContent || '').trim()) && e.offsetParent !== null);
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => {});
  }
  await page.waitForTimeout(2500);
  // 找二维码元素：img 或 canvas，近似正方形、120-320px
  let qrEl = null;
  for (const f of page.frames()) {
    const handles = await f.$$('img, canvas');
    for (const h of handles) {
      const ok = await h.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 120 && r.width < 320 && Math.abs(r.width - r.height) < 40;
      }).catch(() => false);
      if (ok) { qrEl = h; break; }
    }
    if (qrEl) break;
  }
  if (!qrEl) {
    for (const f of page.frames()) {
      const srcs = await f.evaluate(() => [...document.querySelectorAll('img, canvas')].map((e) => e.tagName + ' ' + (e.src || '').slice(0, 60) + ' ' + Math.round(e.getBoundingClientRect().width)).join(' ; ')).catch(() => '');
      log('frame 二维码候选:', srcs);
    }
    return false;
  }
  const png = await qrEl.screenshot();
  log('二维码截图完成,', png.length, 'bytes');
  const imgUrl = await uploadImage(png);
  if (!imgUrl) { log('图床上传失败，无法推送二维码'); return false; }
  log('二维码已上传:', imgUrl);
  await sendWecom('📱 **监控登录失效 · 请扫码恢复**\n⚠️ 此二维码必须用「**网易大神**」App 的扫一扫（将军令）扫码，登录同一网易账号后确认，**藏宝阁 App 和微信扫均无效**。\n约 6 分钟内有效，扫码成功后监控自动恢复。\n![二维码](' + imgUrl + ')\n> 图片打不开时，复制链接到浏览器打开：' + imgUrl);
  // 轮询扫码结果（最长 6 分钟）：以搜索接口实测为准（扫码成功 cookie 立即生效），页面跳转/用户区文本作辅助
  const deadline = Date.now() + 360000;
  let probeCount = 0;
  let lastPng = png;
  let lastQrCheck = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    // 二维码保鲜检测：登录页二维码约 2-3 分钟自动刷新，每 60s 重新截图，变化了就重推新码
    if (Date.now() - lastQrCheck > 60000) {
      lastQrCheck = Date.now();
      try {
        const newPng = await qrEl.screenshot();
        if (Buffer.compare(lastPng, newPng) !== 0) {
          const u2 = await uploadImage(newPng);
          if (u2) {
            lastPng = newPng;
            log('二维码已刷新并重推:', u2);
            await sendWecom('🔄 **二维码已刷新，以此为准**\n请立刻用「网易大神」App 扫一扫（将军令）确认登录\n![二维码](' + u2 + ')\n> 图片打不开时，复制链接到浏览器打开：' + u2);
          }
        }
      } catch (e) { /* 二维码元素可能已消失（登录成功跳转中） */ }
    }
    // 辅助检测 1：页面跳离登录页
    if (page.url().indexOf('show_login') < 0) return await verifyAndExport(ctx, page);
    // 辅助检测 2：主页用户区不再是"梦幻玩家"
    const info = await page.evaluate(() => { const el = document.querySelector('.userInfo'); return el ? el.innerText : ''; }).catch(() => '');
    if (info && !/梦幻玩家/.test(info)) return await verifyAndExport(ctx, page);
    // 主检测：每 15 秒实测一次搜索接口（每 3 个轮询周期执行 1 次，避免请求过密）
    if (++probeCount % 3 === 0) {
      const probeInfo = pickProbe();
      const p = await searchOnce(ctx, probeInfo.criteria, 1, probeInfo.type).catch(() => ({ status: -1 }));
      log('扫码轮询探测 status:', p.status, p.status_code || '');
      if (isOk(p)) return await verifyAndExport(ctx, page);
      // 诊断：登录区状态文本（判断二维码是过期/刷新/等待确认）
      if (probeCount % 12 === 0) {
        const texts = [];
        for (const f of page.frames()) {
          const t = await f.evaluate(() => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100)).catch(() => '');
          if (/二维码|扫码|安全验证|登录|过期|刷新/.test(t)) texts.push(t);
        }
        log('登录区状态:', texts.join(' | ').slice(0, 400) || '(无匹配文本)');
      }
    }
  }
  await sendWecom('⌛ 二维码未在有效期内扫码，监控暂未恢复。30 分钟后会重新推送二维码；也可在 Mac 上双击桌面「刷新藏宝阁登录.command」立即恢复。');
  return false;
}

/** 账密自动登录并复验（在同一浏览器上下文里做，成功返回 true） */
async function autoLogin(page, probeInfo) {
  const ok = await doLogin(page).catch((e) => { log('自动登录异常:', e.message); return false; });
  let loggedIn = ok;
  if (!ok) {
    // 页面文本判定可能误判，用一次真实搜索探测兜底
    const reprobe = await searchOnce(page.context(), probeInfo.criteria, 1, probeInfo.type).catch((e) => ({ status: -1, msg: e.message }));
    log('自动登录后探测 status:', reprobe.status, reprobe.status_code || '', reprobe.msg || '');
    loggedIn = isOk(reprobe);
  }
  return loggedIn;
}

// 凭证模式：优先用本地登录保存的 cookies（SESSION_STATE Secret），
// 失效时先自动尝试账密登录自愈（6 小时限速防风控），仍失败才告警
if (SESSION_B64 && !FORCE_ACCOUNT_LOGIN) {
    let storage;
    try {
      storage = JSON.parse(Buffer.from(SESSION_B64, 'base64').toString('utf8'));
    } catch (e) {
      log('SESSION_STATE 解析失败:', e.message,
        '| Secret 长度:', SESSION_B64.length,
        '| 解码后长度:', Buffer.from(SESSION_B64, 'base64').length,
        '| 前 50 字符:', JSON.stringify(SESSION_B64.slice(0, 50)));
      await alertOnce(state, 'sessfmt', 12, '❌ **搜索监控**\nSESSION_STATE Secret 格式错误。' + LOGIN_HINT);
      await browser.close(); process.exit(1);
    }
    const ctx = await browser.newContext({ storageState: storage, userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const probeInfo = pickProbe();
    const probe = FORCE_QR_LOGIN
      ? { status: -1, msg: 'USE_QR_LOGIN=1 强制二维码模式' }
      : await searchOnce(ctx, probeInfo.criteria, 1, probeInfo.type).catch((e) => ({ status: -1, msg: e.message }));
    log('凭证探测 status:', probe.status, probe.status_code || '', probe.msg || '');
    if (!isOk(probe)) {
      log('登录凭证已失效，启动二维码扫码自愈…');
      // 二维码推送限速：30 分钟一次，避免没来得及扫码时反复刷屏
      const lastQr = state.alerts['qrlogin'] || 0;
      if (Date.now() - lastQr > 1800e3) {
        state.alerts['qrlogin'] = Date.now();
        saveState(state);
        const scanned = await tryQrLogin(ctx, page).catch((e) => { log('二维码登录异常:', e.message); return false; });
        if (scanned) {
          log('✅ 扫码登录成功，监控自动恢复');
          return await runSearch(ctx, enabled, petEnabled, watchItems, state, browser);
        }
        log('二维码未扫码或已过期');
      } else {
        log('二维码登录冷却中（30 分钟），本次跳过');
      }
      await alertOnce(state, 'cred', 12, '⚠️ **搜索监控：登录凭证已失效**\n已尝试推送扫码二维码（每 30 分钟重推一次）仍未恢复，搜索暂停。\n👉 立即恢复：在 Mac 上双击桌面「刷新藏宝阁登录.command」完成登录，云端凭证会自动更新。\n[打开藏宝阁登录页](https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login)');
      await browser.close();
      process.exit(1);
    }
    return await runSearch(ctx, enabled, petEnabled, watchItems, state, browser);
  }

  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 先探测一次数据接口，未登录则走账密登录
  const probeInfo2 = pickProbe();
  let probe = await searchOnce(ctx, probeInfo2.criteria, 1, probeInfo2.type).catch((e) => ({ status: -1, msg: e.message }));
  log('探测结果 status:', probe.status, probe.status_code || '');
  if (probe.status === 2 || probe.status_code === 'SESSION_TIMEOUT' || probe.status === -1) {
    const loggedIn = await autoLogin(page, probeInfo2);
    if (!loggedIn) {
      await alertOnce(state, 'login', 12, '❌ **搜索监控登录失败**\n自动登录未成功，本次未执行搜索。' + LOGIN_HINT);
      await browser.close();
      process.exit(1);
    }
  }

  return await runSearch(ctx, enabled, petEnabled, watchItems, state, browser);
})();

/** 监控链接价格对比（可独立测试）：返回 { alert } 或 { alert: null }，同时更新 state.watch */
function compareWatchItem(state, item, equip) {
  const price = Number(equip.price) || 0;
  const prevRec = state.watch[item.id] || {};
  const prev = Number(prevRec.price) || 0;
  const label = item.name || equip.equip_name || ('链接 ' + item.eid.slice(-10));
  if (!equip.price && !equip.equip_name) {
    // 商品已下架/已售出：只提醒一次
    if (prevRec.price && !prevRec.gone) {
      prevRec.gone = true;
      log(`链接「${label}」已下架/售出`);
      return { alert: { item, label, gone: true } };
    }
    state.watch[item.id] = prevRec;
    return { alert: null };
  }
  if (!prev) {
    // 首次采集：记录基价，不提醒
    state.watch[item.id] = { price, name: label };
    log(`链接「${label}」基价已记录: ${money(price)}元`);
    return { alert: null };
  }
  if (price && prev && price !== prev) {
    const pct = Math.round((price - prev) / prev * 1000) / 10; // 保留1位小数
    const threshold = Math.abs(Number(item.threshold) || 5);
    const up = price > prev;
    log(`链接「${label}」${up ? '涨' : '跌'} ${pct}%（阈值 ${threshold}%）`);
    state.watch[item.id] = { price, name: label, gone: false };
    if (Math.abs(pct) >= threshold) {
      return { alert: { item, label, prev, price, pct, up } };
    }
    return { alert: null };
  }
  state.watch[item.id] = Object.assign({}, prevRec, { price: price || prevRec.price, name: label, gone: false });
  return { alert: null };
}

/** 逐方案搜索（角色 + 召唤兽）+ 监控链接查价 → 去重/变价对比 → 推送 → 写状态文件 */
async function runSearch(ctx, roleSchemes, petSchemes, watchItems, state, browser) {
  if (!state.watch || typeof state.watch !== 'object') state.watch = {};
  const allNew = [];
  const allDrops = []; // 价格变动提醒（仅降价）
  const current = []; // 每方案当前在售列表（用于每日/手动汇总）
  let fatal = null;
  async function runGroup(schemes, searchType, seenPrefix, kindLabel) {
    for (const scheme of schemes) {
      try {
        const res = await searchOnce(ctx, scheme.criteria, 1, searchType);
        if (!isOk(res)) {
          log(`方案「${scheme.name}」(${kindLabel}) 搜索失败:`, res.msg || res.status);
          if (res.status_code === 'SESSION_TIMEOUT') { fatal = '会话失效'; break; }
          continue;
        }
        const list = res.equip_list || [];
        log(`方案「${scheme.name}」(${kindLabel}) 返回 ${list.length} 条`);
        current.push({ scheme, list, kindLabel });
        const seenKey = scheme.id.startsWith(seenPrefix) ? scheme.id : seenPrefix + scheme.id;
        const seenMap = state.seen[seenKey] || {};
        const fresh = [];
        const drops = [];
        for (const r of list) {
          if (!r.game_ordersn) continue;
          const price = Number(r.price) || 0; // 单位：分
          const prev = seenMap[r.game_ordersn];
          if (prev === undefined) {
            fresh.push(r);
            seenMap[r.game_ordersn] = price;
          } else if (price > 0 && prev > 0 && price < prev) {
            drops.push({ r, prev, price });
            seenMap[r.game_ordersn] = price;
          } else if (price > 0 && price > prev) {
            // 涨价只静默更新基价，便于后续降价检测
            seenMap[r.game_ordersn] = price;
          }
        }
        // 容量保护：最多记 500 个订单
        const snKeys = Object.keys(seenMap);
        if (snKeys.length > 500) {
          for (const k of snKeys.slice(0, snKeys.length - 500)) delete seenMap[k];
        }
        state.seen[seenKey] = seenMap;
        if (fresh.length) allNew.push({ scheme, fresh, kindLabel });
        if (drops.length) allDrops.push({ scheme, drops, kindLabel });
      } catch (e) {
        log('方案执行异常:', e.message);
      }
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000)); // 温和轮询
    }
  }
  await runGroup(roleSchemes, SEARCH_TYPE, '', '角色');
  if (!fatal && petSchemes.length) await runGroup(petSchemes, 'overall_search_pet', 'pet_', '召唤兽');

  // ---------- 监控链接价格对比 ----------
  const watchAlerts = []; // { item, prev, price, pct, up }
  if (!fatal && watchItems.length) {
    for (const item of watchItems) {
      try {
        const equip = await fetchWatchPrice(ctx, item);
        const r = compareWatchItem(state, item, equip);
        if (r.alert) watchAlerts.push(r.alert);
      } catch (e) {
        log('链接查询异常:', item.eid, e.message);
        if (/跳转登录/.test(e.message)) { fatal = '会话失效'; break; }
        // 持续解析失败的链接要提醒用户检查（24h 去重），如链接过期或不是有效详情页
        await alertOnce(state, 'wparse_' + item.id, 24, `⚠️ **链接价格监控**\n链接「${item.name || item.eid.slice(-10)}」无法读取价格（${e.message}）。请到链接监控页检查该链接是否有效。`);
      }
      await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));
    }
  }
  await browser.close();

  if (fatal) {
    await alertOnce(state, 'session', 6, '❌ **搜索监控：会话中途失效**\n本次未完成搜索，请重新登录恢复监控。' + LOGIN_HINT);
    process.exit(1);
  }

  if (allNew.length) {
    let md = '🔔 **藏宝阁监控发现新上架**\n';
    allNew.forEach(({ scheme, fresh, kindLabel }) => {
      md += `\n—— ${kindLabel}方案「${scheme.name}」（新 ${fresh.length} 个）——\n`;
      md += fresh.slice(0, 8).map(resultLine).join('\n\n');
      if (fresh.length > 8) md += `\n…等共 ${fresh.length} 个`;
      md += '\n';
    });
    await sendWecom(md);
  } else {
    log('没有新结果');
  }

  if (allDrops.length) {
    let md = '📉 **藏宝阁监控·降价提醒**\n';
    allDrops.forEach(({ scheme, drops, kindLabel }) => {
      md += `\n—— ${kindLabel}方案「${scheme.name}」（降价 ${drops.length} 个）——\n`;
      md += drops.slice(0, 8).map(({ r, prev, price }) => {
        const oldP = money(prev);
        const newP = r.price_desc ? r.price_desc.replace(/\.?0+$/, '') : money(price);
        const pct = Math.round((prev - price) / prev * 100);
        return resultLine(r) + `\n> 💰 ${oldP}元 → **${newP}元**（降 ${pct}%）`;
      }).join('\n\n');
      if (drops.length > 8) md += `\n…等共 ${drops.length} 个`;
      md += '\n';
    });
    await sendWecom(md);
  } else {
    log('没有降价');
  }

  // 监控链接价格变化提醒
  if (watchAlerts.length) {
    let md = '📊 **链接价格监控提醒**\n';
    watchAlerts.slice(0, 10).forEach(({ item, label, prev, price, pct, up, gone }) => {
      const link = `${HOME}/cgi-bin/equip_detail.py?s=${item.serverid}&eid=${encodeURIComponent(item.eid)}&client_type=web&o`;
      if (gone) {
        md += `\n**${label}**\n> ⚠️ 已下架或已售出\n[查看详情](${link})\n`;
      } else {
        md += `\n**${label}**\n> 💰 ${money(prev)}元 → **${price ? money(price) + '元' : '价格未知'}**（${up ? '涨' : '跌'} ${Math.abs(pct)}%，阈值 ${item.threshold}%）\n[查看详情](${link})\n`;
      }
    });
    if (watchAlerts.length > 10) md += `\n…等共 ${watchAlerts.length} 条`;
    await sendWecom(md);
  } else {
    log('监控链接无达到阈值的价格变化');
  }

  // 每日汇总（北京时间 09 点首轮）+ 手动强制汇总（FORCE_DIGEST=1）
  const bjHour = (new Date().getUTCHours() + 8) % 24;
  const bjDate = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const needDigest = process.env.FORCE_DIGEST === '1' || (bjHour === 9 && state.digestDate !== bjDate);
  if (needDigest && current.length) {
    let md = '📋 **藏宝阁监控·当前在售汇总**\n';
    current.forEach(({ scheme, list, kindLabel }) => {
      md += `\n—— ${kindLabel}方案「${scheme.name}」（在售 ${list.length} 条）——\n`;
      if (!list.length) { md += '今日 0 条，暂无符合条件角色（✅ 监控正常运行）\n'; return; }
      md += list.slice(0, 5).map(resultLine).join('\n\n');
      if (list.length > 5) md += `\n…等共 ${list.length} 条`;
      md += '\n';
    });
    if (Object.keys(state.watch).length) {
      md += '\n—— 监控链接最新价 ——\n';
      watchItems.forEach((item) => {
        const rec = state.watch[item.id] || {};
        const label = item.name || rec.name || ('链接 ' + item.eid.slice(-10));
        const st = rec.gone ? '已下架/售出' : (rec.price ? fen2yuan(rec.price) + '元' : '待采集');
        md += `> ${label}：${st}（阈值 ${item.threshold}%）\n`;
      });
      md += '\n';
    }
    await sendWecom(md);
    state.digestDate = bjDate;
    saveState(state);
    log('汇总已发送');
  }

  saveState(state);
  log('状态已写入，待提交');
  process.exit(0);
}

/** 分 → 万元/元 显示 */
function fen2yuan(fen) {
  const n = Number(fen) / 100;
  return n >= 10000 ? (n / 10000).toFixed(2).replace(/\.?0+$/, '') + '万' : String(Math.round(n * 100) / 100);
}
