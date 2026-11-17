/**
 * 藏宝阁搜索监控（GitHub Actions 每 30 分钟运行）
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
const STATE_FILE = path.join(__dirname, '..', 'search-state.json');
const SEARCH_URL = 'https://xyq.cbg.163.com/cgi-bin/recommend.py';
const SEARCH_TYPE = 'overall_search_role';
const HOME = 'https://xyq.cbg.163.com';
const FORM_URL = HOME + '/cgi-bin/xyq_overall_search.py?act=show_search_role_form';

const ACCOUNT = process.env.NETEASE_ACCOUNT || '';
const PASSWORD = process.env.NETEASE_PASSWORD || '';
const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const DRY_RUN = process.env.DRY_RUN === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function sendWecom(md) {
  if (!WEBHOOK) { log('未配置 WECOM_WEBHOOK，跳过通知'); return false; }
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

function resultLine(r) {
  const name = r.equip_name || r.name || '未知角色';
  const price = money(r.price);
  const server = r.server_name || '';
  const level = r.level != null ? r.level + '级' : '';
  const url = `${HOME}/equip?s=${r.server_id || r.serverid}&eid=${r.eid}`;
  let line = `**${name}**（${level}） ${price}元 ${server}`;
  if (r.highlight) {
    const hl = Array.isArray(r.highlight) ? r.highlight.map((h) => h.name || h).join(' / ') : String(r.highlight);
    if (hl) line += '\n> ' + hl.slice(0, 80);
  }
  line += `\n[查看详情](${url})`;
  return line;
}

/** 用已登录的浏览器上下文请求一次搜索（JSONP） */
async function searchOnce(ctx, criteria, pageNo) {
  const page = await ctx.newPage();
  try {
    const qs = new URLSearchParams();
    qs.set('act', 'recommd_by_role');
    qs.set('search_type', SEARCH_TYPE);
    qs.set('page', String(pageNo || 1));
    qs.set('count', '15');
    qs.set('_', String(Date.now()));
    Object.keys(criteria || {}).forEach((k) => qs.set(k, criteria[k]));
    const url = `${SEARCH_URL}?callback=cb&${qs.toString()}`;
    const text = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return await r.text();
    }, url);
    const m = text.match(/^\w+\(([\s\S]*)\)\s*$/);
    if (!m) throw new Error('响应不是 JSONP：' + text.slice(0, 120));
    return JSON.parse(m[1]);
  } finally {
    await page.close().catch(() => {});
  }
}

/** 检查登录态（页面顶部是否出现"退出"） */
async function isLoggedIn(page) {
  return page.evaluate(() => /退出登录|>退出<|切换角色/.test(document.body.innerText));
}

/** 账密登录（登录页 show_login.py?act=show_login，网易统一登录 iframe：dl.reg.163.com） */
async function findPassFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    const has = await f.evaluate(() => !!document.querySelector('input[name=password],input[name=email]')).catch(() => false);
    if (has) return f;
  }
  return null;
}

async function doLogin(page) {
  log('打开登录页…');
  await page.goto(HOME + '/cgi-bin/show_login.py?act=show_login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const target = await findPassFrame(page);
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
  await page.waitForTimeout(9000);
  // 回到藏宝阁主页验证
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const ok = await isLoggedIn(page);
  log('登录结果:', ok ? '成功' : '失败');
  return ok;
}

(async () => {
  const criteriaData = loadJson(CRITERIA_FILE, null);
  if (!criteriaData || !Array.isArray(criteriaData.schemes)) {
    console.error('criteria.json 缺失或格式错误'); process.exit(1);
  }
  const enabled = criteriaData.schemes.filter((s) => s.enabled);
  log(`共 ${criteriaData.schemes.length} 个方案，启用 ${enabled.length} 个`);

  const state = loadJson(STATE_FILE, { seen: {} });

  if (DRY_RUN) {
    enabled.forEach((s) => log('方案', s.name, '条件:', JSON.stringify(s.criteria)));
    await sendWecom('🧪 **搜索监控 DRY-RUN 测试**\n链路连通，webhook 正常。\n启用方案数：' + enabled.length);
    process.exit(0);
  }

  if (!enabled.length) { log('没有启用的方案，结束'); process.exit(0); }
  if (!ACCOUNT || !PASSWORD) {
    // Secret 未配置时静默跳过，避免定时任务反复报错；配置后自动开始工作
    log('未设置 NETEASE_ACCOUNT / NETEASE_PASSWORD Secret，跳过本次运行');
    process.exit(0);
  }

  let { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 先探测一次数据接口，未登录则走账密登录
  let probe = await searchOnce(ctx, enabled[0].criteria, 1).catch((e) => ({ status: -1, msg: e.message }));
  log('探测结果 status:', probe.status, probe.status_code || '');
  if (probe.status === 2 || probe.status_code === 'SESSION_TIMEOUT' || probe.status === -1) {
    const ok = await doLogin(page).catch((e) => { log('登录异常:', e.message); return false; });
    if (!ok) {
      await sendWecom('❌ **搜索监控登录失败**\n自动登录未成功（可能需要验证码或账号密码有误）。请检查 Secret 或人工登录确认。\n本次未执行搜索。');
      await browser.close();
      process.exit(1);
    }
  }

  const allNew = [];
  let fatal = null;
  for (const scheme of enabled) {
    try {
      const res = await searchOnce(ctx, scheme.criteria, 1);
      if (res.status !== 0) {
        log(`方案「${scheme.name}」搜索失败:`, res.msg || res.status);
        if (res.status_code === 'SESSION_TIMEOUT') { fatal = '会话失效'; break; }
        continue;
      }
      const list = res.equip_list || [];
      log(`方案「${scheme.name}」返回 ${list.length} 条`);
      const seen = new Set(state.seen[scheme.id] || []);
      const fresh = list.filter((r) => r.game_ordersn && !seen.has(r.game_ordersn));
      if (fresh.length) {
        state.seen[scheme.id] = [...seen, ...fresh.map((r) => r.game_ordersn)].slice(-500);
        allNew.push({ scheme, fresh });
      }
    } catch (e) {
      log('方案执行异常:', e.message);
    }
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000)); // 温和轮询
  }
  await browser.close();

  if (fatal) {
    await sendWecom('❌ **搜索监控会话失效**\n登录会话被服务端拒绝，本次未完成搜索。请检查账号状态。');
    process.exit(1);
  }

  if (allNew.length) {
    let md = '🔔 **藏宝阁监控发现新角色**\n';
    allNew.forEach(({ scheme, fresh }) => {
      md += `\n—— 方案「${scheme.name}」（新 ${fresh.length} 个）——\n`;
      md += fresh.slice(0, 8).map(resultLine).join('\n\n');
      if (fresh.length > 8) md += `\n…等共 ${fresh.length} 个`;
      md += '\n';
    });
    await sendWecom(md);
  } else {
    log('没有新结果');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ seen: state.seen, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  log('状态已写入，待提交');
  process.exit(0);
})();
