/** 链接价格监控页：管理 N 个藏宝阁链接 + 每条独立变化率阈值 + 云端同步 watch-list.json */
(function () {
  const CLOUD_FILE = 'watch-list.json';
  const STATE_FILE = 'search-state.json'; // 只读：展示监控采集到的最新价格
  const TOKEN_KEY = 'mhy-gh-token';
  const LS_ITEMS = 'mhy-watch-items-v1';
  const LS_CLOUD_REV = 'mhy-watch-rev';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function cloudRepo() {
    const host = location.hostname || '';
    if (/\.github\.io$/i.test(host)) {
      const owner = host.split('.')[0];
      const repo = (location.pathname.split('/').filter(Boolean)[0] || '').replace(/\.git$/, '');
      if (owner && repo) return owner + '/' + repo;
    }
    return 'peng-113/MHXYGJ';
  }

  /** 解析藏宝阁详情链接 → { serverid, eid }；支持 PC 与手机版格式 */
  function parseEquipUrl(url) {
    const u = String(url || '').trim();
    if (!u) return null;
    try {
      // 手机版路径：/cgi/mweb/equip/{serverid}/{eid}
      const m = u.match(/\/cgi\/mweb\/equip\/(\d+)\/([A-Za-z0-9_-]+)/);
      if (m) return { serverid: m[1], eid: m[2] };
      const q = new URL(u, 'https://xyq.cbg.163.com').searchParams;
      const eid = q.get('eid');
      const serverid = q.get('s') || q.get('serverid');
      if (eid && serverid) return { serverid: String(serverid), eid: String(eid) };
    } catch (e) { /* 非法链接 */ }
    return null;
  }

  const pcUrl = (it) => `https://xyq.cbg.163.com/cgi-bin/equip_detail.py?s=${it.serverid}&eid=${encodeURIComponent(it.eid)}&client_type=web&o`;

  // ---------- 数据 ----------
  let items = [];

  function loadLocal() {
    try { items = JSON.parse(localStorage.getItem(LS_ITEMS) || '[]'); } catch (e) { items = []; }
    if (!Array.isArray(items)) items = [];
  }
  function saveLocal() { localStorage.setItem(LS_ITEMS, JSON.stringify(items)); }

  // ---------- 云端同步 ----------
  async function pullCloud() {
    const note = $('cloud-note');
    try {
      const res = await fetch(CLOUD_FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remoteRev = Number(data.rev) || 0;
      const localRev = Number(localStorage.getItem(LS_CLOUD_REV)) || 0;
      if (remoteRev > localRev && Array.isArray(data.items)) {
        items = data.items;
        localStorage.setItem(LS_CLOUD_REV, String(remoteRev));
        saveLocal();
        note.textContent = `已从云端同步监控列表（rev ${remoteRev}，${data.updatedAt || ''}），共 ${items.length} 条链接`;
      } else {
        note.textContent = `云端无更新（rev ${remoteRev}），使用本机数据，共 ${items.length} 条链接`;
      }
    } catch (e) {
      note.textContent = '云端拉取失败（' + e.message + '），使用本机数据。首次使用请直接添加链接并保存到云端';
    }
  }

  async function pushCloud() {
    const token = getToken();
    if (!token) { toast('请先填写 GitHub Token'); return false; }
    const data = { rev: Date.now(), updatedAt: new Date().toISOString(), items };
    const repo = cloudRepo();
    const api = `https://api.github.com/repos/${repo}/contents/${CLOUD_FILE}`;
    let sha;
    try {
      const r = await fetch(api + '?t=' + Date.now(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
      if (r.ok) sha = (await r.json()).sha;
    } catch (e) { /* 文件可能不存在 */ }
    const body = {
      message: '更新链接价格监控列表（网页保存）',
      content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n'))),
      branch: 'main',
    };
    if (sha) body.sha = sha;
    const res = await fetch(api, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast('云端保存失败：' + (err.message || res.status));
      return false;
    }
    localStorage.setItem(LS_CLOUD_REV, String(data.rev));
    saveLocal();
    toast(`已保存到云端（共 ${items.length} 条），定时任务下个周期生效`);
    $('cloud-note').textContent = `云端已更新（rev ${data.rev}）`;
    return true;
  }

  /** 从 search-state.json 读取监控采集到的最新价（只读展示） */
  async function fetchWatchState() {
    try {
      const res = await fetch(STATE_FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return {};
      const s = await res.json();
      return s.watch || {};
    } catch (e) { return {}; }
  }

  // ---------- 渲染 ----------
  const fen2yuan = (fen) => { const n = Number(fen) / 100; return n >= 10000 ? (n / 10000).toFixed(2).replace(/\.?0+$/, '') + '万' : String(Math.round(n * 100) / 100); };

  function renderItem(it, ws) {
    const on = !!ws[it.id];
    let badge = '<span class="badge pending">待监控采集</span>';
    if (on && ws[it.id].gone) badge = '<span class="badge gone">已下架/已售出</span>';
    else if (on && ws[it.id].price) badge = `<span class="badge ok">最新价 ${esc(fen2yuan(ws[it.id].price))} 元</span>`;
    return `<div class="watch-item ${it.enabled ? '' : 'wi-off'}" data-id="${it.id}">
      <div class="wi-head">
        <div><span class="wi-name">${esc(it.name || '链接 ' + (items.indexOf(it) + 1))}</span>${badge}</div>
        <div class="row" style="gap:6px">
          <label class="chip ${it.enabled ? 'on' : ''}" data-act="toggle">${it.enabled ? '☑ 监控中' : '☐ 已停用'}</label>
          <button class="btn ghost small" data-act="del">删除</button>
        </div>
      </div>
      <div class="wi-url">${esc(pcUrl(it))}</div>
      <div class="wi-rows">
        <div class="fld-row">
          <span class="f-label">备注名</span>
          <input type="text" data-act="name" value="${esc(it.name || '')}" placeholder="选填" style="flex:1;min-width:100px;">
          <span class="f-label" style="min-width:auto">变化率≥</span>
          <input type="number" data-act="threshold" value="${esc(it.threshold)}" min="0.1" step="0.1" style="width:80px;">
          <span class="unit">%（涨跌都提醒）</span>
        </div>
      </div>
    </div>`;
  }

  function renderList(ws) {
    const box = $('watch-list');
    if (!items.length) {
      box.innerHTML = '<div class="footer-note hint">还没有监控链接。在上方粘贴藏宝阁详情链接添加，数量不限。</div>';
    } else {
      box.innerHTML = items.map((it) => renderItem(it, ws)).join('');
    }
    const enabledN = items.filter((i) => i.enabled).length;
    $('sf-meta').innerHTML = `共 ${items.length} 条链接 · 监控中 ${enabledN} 条<br>阈值达到即推送涨跌通知`;
  }

  function updateMeta() { const cur = { }; /* 占位，renderList 时刷新 */ }

  // ---------- 事件 ----------
  function bindEvents(wsGetter) {
    // 添加
    $('btn-add').addEventListener('click', () => {
      const url = $('add-url').value.trim();
      const parsed = parseEquipUrl(url);
      if (!parsed) { toast('链接格式不对，请粘贴藏宝阁详情页链接'); return; }
      if (items.find((i) => i.eid === parsed.eid && String(i.serverid) === String(parsed.serverid))) { toast('该链接已在监控列表中'); return; }
      let threshold = parseFloat($('add-threshold').value);
      if (!(threshold > 0)) { toast('变化率请填写大于 0 的数字'); return; }
      items.push({
        id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: $('add-name').value.trim(),
        url, serverid: parsed.serverid, eid: parsed.eid,
        threshold: Math.round(threshold * 10) / 10,
        enabled: true,
      });
      $('add-url').value = ''; $('add-name').value = '';
      saveLocal();
      renderList(wsGetter());
      toast('已添加，记得「保存到云端」生效');
    });
    // 列表操作（事件委托）
    $('watch-list').addEventListener('click', (e) => {
      const box = e.target.closest('.watch-item');
      if (!box) return;
      const it = items.find((i) => i.id === box.getAttribute('data-id'));
      if (!it) return;
      const act = e.target.getAttribute('data-act') || e.target.closest('[data-act]')?.getAttribute('data-act');
      if (act === 'toggle') {
        it.enabled = !it.enabled;
        saveLocal(); renderList(wsGetter());
      } else if (act === 'del') {
        if (!confirm(`删除「${it.name || '该链接'}」的监控？`)) return;
        items = items.filter((i) => i !== it);
        saveLocal(); renderList(wsGetter());
        toast('已删除，记得「保存到云端」生效');
      }
    });
    // 阈值/备注名实时编辑
    $('watch-list').addEventListener('change', (e) => {
      const box = e.target.closest('.watch-item');
      if (!box) return;
      const it = items.find((i) => i.id === box.getAttribute('data-id'));
      if (!it) return;
      const act = e.target.getAttribute('data-act');
      if (act === 'threshold') {
        const v = parseFloat(e.target.value);
        if (!(v > 0)) { toast('变化率请填写大于 0 的数字'); renderList(wsGetter()); return; }
        it.threshold = Math.round(v * 10) / 10;
        saveLocal();
        toast(`「${it.name || '该链接'}」阈值已改为 ${it.threshold}%，记得保存到云端`);
      } else if (act === 'name') {
        it.name = e.target.value.trim();
        saveLocal();
      }
    });
    // Token / 保存
    $('btn-save-token').addEventListener('click', () => {
      const v = $('gh-token').value.trim();
      if (v) { localStorage.setItem(TOKEN_KEY, v); toast('Token 已保存'); }
      else toast('请输入 Token');
    });
    $('btn-save-local').addEventListener('click', () => { saveLocal(); toast(`已存本机（${items.length} 条）`); });
    $('btn-save-cloud').addEventListener('click', async () => {
      $('btn-save-cloud').disabled = true;
      await pushCloud();
      $('btn-save-cloud').disabled = false;
    });
  }

  // ---------- 启动 ----------
  (async function init() {
    $('gh-token').value = getToken();
    loadLocal();
    let watchState = {};
    const wsGetter = () => watchState;
    bindEvents(wsGetter);
    renderList(watchState);
    await pullCloud();
    watchState = await fetchWatchState();
    renderList(watchState);
    // 每 60 秒刷新一次监控采集价（search-state.json 约每 30 分钟更新）
    setInterval(async () => { watchState = await fetchWatchState(); renderList(watchState); }, 60e3);
  })();
})();
