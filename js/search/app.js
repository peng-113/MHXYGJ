/** 搜索监控 · 条件筛选页逻辑：渲染字段、收集条件、多方案管理、云端同步 */
(function () {
  const MHY = window.MHY;
  const FIELDS = MHY.SEARCH_FIELDS;
  const SERVERS = window.MHY_SERVERS || [];
  const CLOUD_FILE = 'criteria.json';
  const TOKEN_KEY = 'mhy-gh-token';
  const LS_SCHEMES = 'mhy-search-schemes-v1';
  const LS_CLOUD_REV = 'mhy-search-criteria-rev';
  const CGI = 'https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py';

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

  // ---------- 方案数据 ----------
  let schemes = [];
  let curId = '';

  const newScheme = (name) => ({ id: 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || '未命名方案', enabled: true, criteria: {} });

  function loadLocal() {
    try { schemes = JSON.parse(localStorage.getItem(LS_SCHEMES) || '[]'); } catch (e) { schemes = []; }
    if (!schemes.length) schemes = [newScheme('方案一')];
    curId = localStorage.getItem(LS_SCHEMES + ':cur') || schemes[0].id;
    if (!schemes.find((s) => s.id === curId)) curId = schemes[0].id;
  }
  function saveLocal() {
    localStorage.setItem(LS_SCHEMES, JSON.stringify(schemes));
    localStorage.setItem(LS_SCHEMES + ':cur', curId);
  }
  const cur = () => schemes.find((s) => s.id === curId) || schemes[0];

  // ---------- 云端同步 ----------
  async function pullCloud() {
    const note = $('cloud-note');
    try {
      const res = await fetch(CLOUD_FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const remoteRev = Number(data.rev) || 0;
      const localRev = Number(localStorage.getItem(LS_CLOUD_REV)) || 0;
      if (remoteRev > localRev) {
        schemes = Array.isArray(data.schemes) && data.schemes.length ? data.schemes : schemes;
        if (!schemes.find((s) => s.id === curId)) curId = schemes[0].id;
        localStorage.setItem(LS_CLOUD_REV, String(remoteRev));
        saveLocal();
        note.textContent = `已从云端同步条件（rev ${remoteRev}，${data.updatedAt || ''}），当前方案：${cur().name}`;
      } else {
        note.textContent = `云端无更新（rev ${remoteRev}），使用本机数据。当前方案：${cur().name}`;
      }
    } catch (e) {
      note.textContent = '云端拉取失败（' + e.message + '），使用本机数据';
    }
  }

  async function pushCloud() {
    const token = getToken();
    if (!token) { toast('请先填写 GitHub Token'); return false; }
    collectCriteria();
    const data = { rev: Date.now(), updatedAt: new Date().toISOString(), schemes };
    const repo = cloudRepo();
    const api = `https://api.github.com/repos/${repo}/contents/${CLOUD_FILE}`;
    // 先取现有 sha
    let sha;
    try {
      const r = await fetch(api + '?t=' + Date.now(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
      if (r.ok) sha = (await r.json()).sha;
    } catch (e) { /* 忽略，可能文件不存在 */ }
    const body = {
      message: '更新搜索监控条件（网页保存）',
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
    toast('已保存到云端，定时任务下个周期生效');
    $('cloud-note').textContent = `云端已更新（rev ${data.rev}）`;
    return true;
  }

  // ---------- 渲染 ----------
  function opts(name) { return FIELDS.enums[name] || []; }

  function renderField(f) {
    const c = cur().criteria || {};
    if (f.type === 'server') {
      return `<div class="fld-row"><span class="f-label">${f.label}</span><div class="server-cascade" style="flex:1">
        <select id="f-area"><option value="">全服（不选服务器）</option>${SERVERS.map((a) => `<option value="${esc(a.area)}">${esc(a.area)}</option>`).join('')}</select>
        <select id="f-serverid" data-key="serverid"><option value="">全部服务器</option></select></div></div>`;
    }
    if (f.type === 'min') {
      return `<div class="fld-row"><span class="f-label">${f.label} ≥</span><input type="number" inputmode="numeric" id="f-${f.key}" data-key="${f.key}" placeholder="不限"></div>`;
    }
    if (f.type === 'range') {
      return `<div class="fld-row"><span class="f-label">${f.label}</span>
        <input type="number" inputmode="numeric" id="f-${f.key}_min" data-key="${f.key}_min" placeholder="最低">
        <span class="sep">–</span>
        <input type="number" inputmode="numeric" id="f-${f.key}_max" data-key="${f.key}_max" placeholder="最高">
        <span class="unit">${f.unit || ''}</span>
        ${f.quick ? `<div class="quick-row">${f.quick.map((q) => `<span class="chip quick" data-quick="${f.key}" data-v="${q[0]}">${q[1]}</span>`).join('')}</div>` : ''}
      </div>`;
    }
    if (f.type === 'select') {
      let list = typeof f.options === 'string' ? opts(f.options) : f.options;
      if (!list.length || list[0][0] !== '') list = [['', '不限']].concat(list); // 保证有"不限"默认项
      return `<div class="fld-row"><span class="f-label">${f.label}</span><select id="f-${f.key}" data-key="${f.key}" style="flex:0 1 180px">
        ${list.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('')}</select></div>`;
    }
    if (f.type === 'multi') {
      const list = typeof f.options === 'string' ? opts(f.options).concat(f.extra || []) : f.options;
      return `<div class="fld-row"><span class="f-label">${f.label}</span><div class="chip-row" data-key="${f.key}" data-multi="1">
        ${list.map((o) => `<span class="chip" data-v="${esc(o[0])}">${esc(o[1])}</span>`).join('')}</div></div>`;
    }
    if (f.type === 'huasheng') {
      return `<div class="fld-row"><span class="f-label">飞升/渡劫/化圣</span>
        <div class="chip-row" data-huasheng="1" style="padding:0">
          <span class="chip" data-v="">不限</span><span class="chip" data-v="1">已飞升</span><span class="chip" data-v="2">已渡劫</span><span class="chip" data-v="hs">已化圣</span>
        </div>
        <select id="f-hs-level" style="display:none"><option value="">化圣境界不限</option>${opts('huashengLevel').filter((o) => o[0]).map((o) => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>
      </div>`;
    }
    if (f.type === 'jiyuan') {
      return `<div class="fld-row"><span class="f-label">${f.label}</span>
        <div class="chip-row" data-jiyuan="1" style="padding:0">
          <span class="chip" data-v="ji_yuan_point">机缘属性</span><span class="chip" data-v="addon_point">月饼粽子</span>
        </div>
        <span class="sep">总和≥</span><input type="number" inputmode="numeric" id="f-jiyuan-total" placeholder="不限">
      </div>`;
    }
    return '';
  }

  function renderCats() {
    $('cats').innerHTML = FIELDS.categories.map((cat, i) => `
      <details class="cat" ${i === 0 ? 'open' : ''} id="cat-${cat.id}">
        <summary>${cat.title}<span class="cnt" id="cnt-${cat.id}"></span></summary>
        <div class="cat-body">${cat.fields.map(renderField).join('')}</div>
      </details>`).join('');
    // 大区联动
    $('f-area').addEventListener('change', () => {
      const area = SERVERS.find((a) => a.area === $('f-area').value);
      $('f-serverid').innerHTML = '<option value="">全部服务器</option>' + (area ? area.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '');
    });
    // 通用事件委托
    $('cats').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (chip.classList.contains('quick')) {
        const key = chip.getAttribute('data-quick');
        $('f-' + key + '_min').value = chip.getAttribute('data-v');
        $('f-' + key + '_max').value = chip.getAttribute('data-v');
        return;
      }
      const row = chip.closest('[data-multi]');
      if (row) { chip.classList.toggle('on'); updateCounters(); return; }
      const hsRow = chip.closest('[data-huasheng]');
      if (hsRow) {
        hsRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        const lv = $('f-hs-level');
        lv.style.display = chip.getAttribute('data-v') === 'hs' ? '' : 'none';
        updateCounters();
        return;
      }
      const jyRow = chip.closest('[data-jiyuan]');
      if (jyRow) { chip.classList.toggle('on'); updateCounters(); return; }
    });
    $('cats').addEventListener('change', updateCounters);
    $('cats').addEventListener('input', updateCounters);
  }

  /** 把当前方案的值写进表单 */
  function fillForm() {
    const c = cur().criteria || {};
    Object.keys(c).forEach((k) => {
      let v = c[k];
      if (/^price_(min|max)$/.test(k)) v = String(Number(v) / 100); // 分 → 元，供界面显示
      const el = $('f-' + k);
      if (el) { el.value = v; return; }
      if (k === 'serverid') {
        // 反查大区
        let hit = null;
        SERVERS.forEach((a) => a.servers.forEach((s) => { if (String(s.id) === String(v)) hit = a; }));
        if (hit) {
          $('f-area').value = hit.area;
          $('f-serverid').innerHTML = '<option value="">全部服务器</option>' + hit.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
          $('f-serverid').value = String(v);
        }
        return;
      }
      if (k === 'zhuang_zhi') {
        const hsRow = document.querySelector('[data-huasheng]');
        hsRow.querySelectorAll('.chip').forEach((ch) => ch.classList.remove('on'));
        if (v === '1' || v === '2') { hsRow.querySelector(`.chip[data-v="${v}"]`).classList.add('on'); }
        else if (/^[\d,]+$/.test(String(v))) {
          hsRow.querySelector('.chip[data-v="hs"]').classList.add('on');
          const codes = String(v).split(',').map(Number);
          const min = Math.min.apply(null, codes);
          $('f-hs-level').style.display = '';
          $('f-hs-level').value = String(min);
        }
        return;
      }
      if (k === 'jiyuan_and_addpoint' || k === 'ji_yuan_point' || k === 'addon_point') {
        const jyRow = document.querySelector('[data-jiyuan]');
        if (k === 'jiyuan_and_addpoint') { jyRow.querySelectorAll('.chip').forEach((ch) => ch.classList.add('on')); }
        else { jyRow.querySelector(`.chip[data-v="${k}"]`).classList.add('on'); }
        $('f-jiyuan-total').value = v;
        return;
      }
      // 多选
      const row = document.querySelector(`.chip-row[data-key="${k}"]`);
      if (row) {
        String(v).split(',').forEach((val) => {
          const ch = row.querySelector(`.chip[data-v="${val}"]`);
          if (ch) ch.classList.add('on');
        });
      }
    });
    updateCounters();
  }

  /** 从表单收集条件（官网 args 键名） */
  function collectCriteria() {
    const c = {};
    // 普通单值
    document.querySelectorAll('#cats [data-key]').forEach((el) => {
      const k = el.getAttribute('data-key');
      const v = String(el.value || '').trim();
      if (!v) return;
      if (/^price_(min|max)$/.test(k)) c[k] = String(parseInt(parseFloat(v) * 100, 10)); // 元 → 分
      else c[k] = v;
    });
    // 多选组
    document.querySelectorAll('#cats .chip-row[data-key]').forEach((row) => {
      const vals = [...row.querySelectorAll('.chip.on')].map((ch) => ch.getAttribute('data-v'));
      if (vals.length) c[row.getAttribute('data-key')] = vals.join(',');
    });
    // 化圣
    const hsRow = document.querySelector('[data-huasheng]');
    const hsOn = hsRow.querySelector('.chip.on');
    if (hsOn) {
      const v = hsOn.getAttribute('data-v');
      if (v === 'hs') {
        const lv = parseInt($('f-hs-level').value, 10) || 10;
        const codes = [];
        for (let x = lv; x <= 90; x += 10) codes.push(x);
        c.zhuang_zhi = codes.join(',');
      } else if (v) { c.zhuang_zhi = v; }
    }
    // 机缘
    const jyRow = document.querySelector('[data-jiyuan]');
    const jyOn = [...jyRow.querySelectorAll('.chip.on')];
    const total = String($('f-jiyuan-total').value || '').trim();
    if (jyOn.length && total) {
      if (jyOn.length >= 2) c.jiyuan_and_addpoint = total;
      else c[jyOn[0].getAttribute('data-v')] = total;
    }
    cur().criteria = c;
  }

  function updateCounters() {
    collectCriteria();
    FIELDS.categories.forEach((cat) => {
      const n = Object.keys(cur().criteria).filter((k) => cat.fields.some((f) => k === f.key || (f.type === 'range' && k.startsWith(f.key + '_')) || (f.type === 'jiyuan' && /^(jiyuan_and_addpoint|ji_yuan_point|addon_point)$/.test(k))));
      const el = $('cnt-' + cat.id);
      if (el) el.textContent = n.length ? `${n.length} 项` : '';
    });
    const total = Object.keys(cur().criteria).length;
    $('sf-meta').innerHTML = `当前方案：${esc(cur().name)}<br>已设条件 ${total} 项 · ${cur().enabled ? '已启用' : '已停用'}`;
    $('scheme-enabled').classList.toggle('on', !!cur().enabled);
  }

  // ---------- 方案管理 ----------
  function renderSchemeSelect() {
    $('scheme-select').innerHTML = schemes.map((s) => `<option value="${s.id}" ${s.id === curId ? 'selected' : ''}>${esc(s.name)}${s.enabled ? ' ✓' : ''}</option>`).join('');
  }

  function bindTop() {
    $('scheme-select').addEventListener('change', () => { curId = $('scheme-select').value; saveLocal(); fillForm(); });
    $('btn-scheme-new').addEventListener('click', () => {
      const name = prompt('新方案名称：', '方案' + (schemes.length + 1));
      if (name === null) return;
      const s = newScheme(name || '未命名方案');
      schemes.push(s);
      curId = s.id;
      saveLocal();
      renderSchemeSelect();
      fillForm();
    });
    $('btn-scheme-del').addEventListener('click', () => {
      if (schemes.length <= 1) { toast('至少保留一个方案'); return; }
      if (!confirm(`删除方案「${cur().name}」？`)) return;
      schemes = schemes.filter((s) => s.id !== curId);
      curId = schemes[0].id;
      saveLocal();
      renderSchemeSelect();
      fillForm();
    });
    $('scheme-enabled').addEventListener('click', () => {
      cur().enabled = !cur().enabled;
      saveLocal();
      updateCounters();
      toast(cur().enabled ? '方案已启用' : '方案已停用');
    });
    $('btn-save-local').addEventListener('click', () => { collectCriteria(); saveLocal(); toast('已存本机'); updateCounters(); });
    $('btn-save-cloud').addEventListener('click', async () => { collectCriteria(); saveLocal(); $('btn-save-cloud').disabled = true; await pushCloud(); $('btn-save-cloud').disabled = false; });
    $('btn-save-token').addEventListener('click', () => {
      const v = $('gh-token').value.trim();
      if (v) { localStorage.setItem(TOKEN_KEY, v); toast('Token 已保存'); }
      else { toast('请输入 Token'); }
    });
  }

  // ---------- 启动 ----------
  function init() {
    $('gh-token').value = getToken();
    loadLocal();
    renderCats();
    bindTop();
    renderSchemeSelect();
    fillForm();
    pullCloud().then(() => { fillForm(); });
  }
  init();
})();
