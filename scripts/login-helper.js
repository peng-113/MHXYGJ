/**
 * 本地登录助手：打开真实浏览器窗口，人工完成滑块验证登录，
 * 成功后把登录凭证（cookies）保存为 session-state.json
 * 用法：node scripts/login-helper.js
 */
const fs = require('fs');
const { chromium } = require('playwright');

const FORM_URL = 'https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_search_role_form';
const LOGIN_URL = 'https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  console.log('已打开登录窗口，请在浏览器里完成登录（滑块验证等）。本脚本会自动检测登录成功…');

  // 轮询检测登录成功：访问搜索表单页，看用户区是否不再是"梦幻玩家"
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    try {
      await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const txt = await page.evaluate(() => {
        const el = document.querySelector('.userInfo');
        return el ? (el.innerText || '').replace(/\s+/g, ' ') : '';
      });
      if (txt && !/梦幻玩家/.test(txt)) {
        console.log('检测到登录成功！用户区:', txt);
        const state = await ctx.storageState();
        fs.writeFileSync('session-state.json', JSON.stringify(state));
        // 用一次真实搜索验证
        const probe = await page.evaluate(async () => {
          const u = 'https://xyq.cbg.163.com/cgi-bin/recommend.py?callback=cb&act=recommd_by_role&search_type=overall_search_role&page=1&count=1&_=' + Date.now();
          const r = await fetch(u, { credentials: 'include' });
          const t = await r.text();
          const m = t.match(/^\w+\(([\s\S]*)\)\s*$/);
          return m ? JSON.parse(m[1]).status : -1;
        });
        console.log('搜索接口探测 status:', probe, probe === 0 ? '(已登录，凭证有效)' : '(接口仍未登录，凭证可能不完整)');
        console.log('LOGIN_OK 凭证已保存到 session-state.json');
        await browser.close();
        process.exit(probe === 0 ? 0 : 2);
      }
    } catch (e) { /* 页面跳转中，继续等 */ }
  }
  console.error('超时：5 分钟内未检测到登录成功');
  await browser.close();
  process.exit(1);
})();
