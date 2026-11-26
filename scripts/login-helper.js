/**
 * 本地登录助手 v6（抓包版）：登录后保存完整会话 + 抓取新版网站实际调用的接口。
 * 用法：node scripts/login-helper.js
 *
 * 做四件事：
 * 1. 每 15 秒无条件保存 cookies+localStorage 快照到 session-state.json（无论如何都留底）；
 * 2. 记录页面上所有数据接口请求（方法/URL/关键响应头），过滤静态资源；
 * 3. 记录 JSON 响应体前 300 字符（识别新版搜索接口的返回结构）；
 * 4. 持续探测老接口 recommend.py 是否恢复（若恢复立即确认并关窗）。
 */
const fs = require('fs');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login';
const PROBE_URL = 'https://xyq.cbg.163.com/cgi-bin/recommend.py?callback=cb&act=recommd_by_role&search_type=overall_search_role&page=1&count=1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const seen = new Set();

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  console.log('已打开登录窗口。请完成登录 → 选角色 → 进入能看到商品价格的页面后，保持窗口打开 2~3 分钟（脚本抓接口）。');

  browser.on('disconnected', () => {
    console.log('浏览器窗口已被关闭。快照已保存，登录助手退出。');
    process.exit(1);
  });

  // 抓数据接口请求
  page.on('request', (req) => {
    const u = req.url();
    if (!/cbg\.163\.com|reg\.163\.com|passport/.test(u)) return;
    if (/\.(js|css|png|jpg|gif|woff2?|svg|ico|mp4)(\?|$)/.test(u)) return;
    const key = req.method() + ' ' + u.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    const headers = req.headers();
    const authKeys = Object.keys(headers).filter((h) => /auth|token|csrf|device|sign/i.test(h)).map((h) => h + '=' + headers[h].slice(0, 60));
    console.log('REQ:', req.method(), u.slice(0, 160), authKeys.length ? '| ' + authKeys.join(' ') : '');
  });
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/cbg\.163\.com/.test(u)) return;
    if (/\.(js|css|png|jpg|gif|woff2?|svg|ico|mp4)(\?|$)/.test(u)) return;
    const ct = (resp.headers()['content-type'] || '');
    if (!/json|text\/plain|javascript/.test(ct)) return;
    try {
      const body = (await resp.text()).slice(0, 300).replace(/\s+/g, ' ');
      console.log('RES[' + resp.status() + ']:', u.split('?')[0].slice(0, 120), '|', body);
    } catch (e) {}
  });

  // 无条件快照 + 老接口探测
  const deadline = Date.now() + 60 * 60 * 1000;
  let lastSig = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const state = await ctx.storageState();
      fs.writeFileSync('session-state.json', JSON.stringify(state));
      const cookies = state.cookies;
      console.log(`[${new Date().toLocaleTimeString()}] 快照已保存: ${cookies.length} cookies, origins=[${state.origins.map((o) => o.origin).join(',')}]`);

      const p = await (async () => {
        try {
          const r = await ctx.request.get(PROBE_URL + '&_=' + Date.now(), { timeout: 20000, headers: { 'User-Agent': UA, 'Referer': 'https://xyq.cbg.163.com/' } });
          const t = await r.text();
          const m = t.match(/^\w+\(([\s\S]*)\)\s*$/);
          return m ? JSON.parse(m[1]) : { status: -1 };
        } catch (e) { return { status: -1, msg: e.message }; }
      })();
      const sig = p.status + '|' + (p.status_code || '');
      if (sig !== lastSig) {
        lastSig = sig;
        console.log('老接口探测:', JSON.stringify({ status: p.status, status_code: p.status_code, msg: p.msg }));
      }
      if (p.status === 0 || p.status === 1 || p.status_code === 'OK') {
        console.log('✅ 老接口恢复可用！凭证有效，LOGIN_OK');
        console.log('LOGIN_OK 凭证已保存到 session-state.json');
        await browser.close();
        process.exit(0);
      }
    } catch (e) {
      console.log('轮询异常:', e.message.slice(0, 100));
    }
  }
  console.error('超时退出');
  await browser.close();
  process.exit(1);
})();
