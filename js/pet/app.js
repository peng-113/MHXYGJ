/** 召唤兽搜索 · 条件筛选页逻辑：渲染字段、收集条件、多方案管理、云端同步
 *  表单字段与官网召唤兽高级搜索 1:1 对应（overall_search_pet），criteria 使用官网 args 键名。
 */
(function () {
  const PET = window.MHY_PET;
  const SERVERS = window.MHY_SERVERS || [];
  const CLOUD_FILE = 'pet-criteria.json';
  const TOKEN_KEY = 'mhy-gh-token';
  const LS_SCHEMES = 'mhy-pet-schemes-v1';
  const LS_CLOUD_REV = 'mhy-pet-criteria-rev';

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

  const newScheme = (name) => ({ id: 'pet_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || '未命名方案', enabled: true, criteria: {} });

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
      note.textContent = '云端暂无条件文件（' + e.message + '），使用本机数据';
    }
  }

  async function pushCloud() {
    const token = getToken();
    if (!token) { toast('请先填写 GitHub Token'); return false; }
    collectCriteria();
    const data = { rev: Date.now(), updatedAt: new Date().toISOString(), schemes };
    const repo = cloudRepo();
    const api = `https://api.github.com/repos/${repo}/contents/${CLOUD_FILE}`;
    let sha;
    try {
      const r = await fetch(api + '?t=' + Date.now(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
      if (r.ok) sha = (await r.json()).sha;
    } catch (e) { /* 文件可能不存在 */ }
    const body = {
      message: '更新召唤兽搜索条件（网页保存）',
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
  const chips = (key, list) => `<div class="chip-row" ${key ? `data-key="${key}"` : ''} data-multi="1">
    ${list.map((o) => `<span class="chip" data-v="${esc(o[0])}">${esc(o[1])}</span>`).join('')}</div>`;

  const minRow = (key, label) => `<div class="fld-row"><span class="f-label">${label} ≥</span><input type="number" inputmode="numeric" id="f-${key}" data-key="${key}" placeholder="不限"></div>`;

  const rangeRow = (key, label, unit) => `<div class="fld-row"><span class="f-label">${label}</span>
    <input type="number" inputmode="numeric" id="f-${key}_min" data-key="${key}_min" placeholder="最低">
    <span class="sep">–</span>
    <input type="number" inputmode="numeric" id="f-${key}_max" data-key="${key}_max" placeholder="最高">
    <span class="unit">${unit || ''}</span></div>`;

  const flagChip = (key, label) => `<span class="chip" data-flag="${key}" data-v="1">${esc(label)}</span>`;

  function skillPanel(key, groups, collapsible) {
    return `<div class="skill-panel" data-key="${key}" data-multi="1">
      ${groups.map((g, gi) => `<div class="skill-group" ${collapsible && gi > 0 ? 'style="display:none"' : ''}>
        <div class="g-title">${esc(g[1])}</div>${chips('', g[2])}</div>`).join('')}
      ${collapsible ? '<div class="skill-expand">展开全部分组 ▾</div>' : ''}
    </div>`;
  }

  function renderCats() {
    const CATS = [
      {
        id: 'basic', title: '基本信息', body: `
        <div class="fld-row"><span class="f-label">名称</span>
          <input type="text" id="f-type" list="pet-name-list" placeholder="输入或选择召唤兽名" style="flex:0 1 200px">
          <datalist id="pet-name-list">${PET.petNames.map((n) => `<option value="${esc(n[0])}">`).join('')}</datalist>
        </div>
        <div class="fld-row"><span class="f-label">参战等级</span>${chips('kindid', PET.fightLevels)}</div>
        ${rangeRow('level', '等级', '级')}
        <div class="fld-row"><span class="f-label">出售状态</span>${chips('front_status', [['pass_fair_show', '已上架'], ['fair_show', '公示期']])}</div>
        <div class="fld-row"><span class="f-label">变异类型</span>${chips('color', [['1', '1'], ['2', '2']])}</div>
        <div class="fld-row"><span class="f-label">只显示宝宝</span>${chips('is_baobao', [['1', '是']])}</div>`,
      },
      {
        id: 'skills', title: '技能', body: `
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">包含技能</span>
          ${skillPanel('skill', PET.skillGroups, true)}
        </div>
        <div class="fld-row"><span class="f-label">技能选项</span>
          <div class="chk-row">
            ${flagChip('skill_with_suit', '含套装技能')}
            ${flagChip('suit_as_any_skill', '套装任意技能')}
            ${flagChip('skill_including_advanced', '默认等同高级技能')}
          </div>
          <span class="unit">含套装 与 套装任意 互斥</span>
        </div>
        <div class="fld-row"><span class="f-label">技能数量</span>
          <input type="number" inputmode="numeric" id="f-skill_num" data-key="skill_num" placeholder="≥ 不限">
          <span class="chip" data-flag="no_include_sp_skill" data-v="1">不含认证技能</span>
        </div>
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">不含技能</span>
          ${skillPanel('not_in_skill', PET.skillGroups.map((g) => [g[0] === 'low' ? 'lowForNot' : g[0], g[1], g[0] === 'low' ? PET.skillLowForNot : g[2]]), false)}
        </div>
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">等同高级低级技能</span>
          ${chips('low_skill', PET.lowEqualSkills)}
        </div>`,
      },
      {
        id: 'evol', title: '赐福技能', body: `
        <div class="fld-row"><span class="f-label">赐福技能</span>${chips('evol_skill', PET.evolSkills)}</div>
        <div class="fld-row"><span class="f-label">匹配方式</span>
          <span class="chip" data-flag="evol_skill_mode" data-v="1">满足全部</span>
          <span class="unit">不勾选 = 满足任意一种</span>
        </div>
        ${minRow('valid_evol_skill_num', '有效赐福技能数')}
        <div class="fld-row"><span class="f-label">赐福选项</span>
          <span class="chip" data-flag="advanced_evol_skill" data-v="1">仅含高级技能赐福</span>
        </div>`,
      },
      {
        id: 'overview', title: '概况', body: `
        <div class="fld-row"><span class="f-label">成长 ≥</span>
          <input type="text" inputmode="decimal" id="f-growth" data-key="growth" placeholder="如 1.3" style="flex:0 1 110px">
        </div>
        <div class="fld-row"><span class="f-label">炼兽珍经 ≤</span><input type="number" inputmode="numeric" id="f-used_lianshou_max" data-key="used_lianshou_max" placeholder="不限"></div>
        <div class="fld-row"><span class="f-label">已用元宵 ≤</span><input type="number" inputmode="numeric" id="f-used_yuanxiao_max" data-key="used_yuanxiao_max" placeholder="不限"></div>`,
      },
      {
        id: 'zizhi', title: '资质', body: `
        ${minRow('attack_aptitude', '攻击资质')}
        ${minRow('defence_aptitude', '防御资质')}
        ${minRow('physical_aptitude', '体力资质')}
        ${minRow('magic_aptitude', '法力资质')}
        ${rangeRow('speed_aptitude', '速度资质', '')}`,
      },
      {
        id: 'attrs', title: '属性', body: `
        ${minRow('max_blood', '气血')}
        ${minRow('attack', '攻击')}
        ${minRow('defence', '防御')}
        ${rangeRow('speed', '速度', '')}
        ${minRow('fashang', '法伤')}
        ${minRow('fafang', '法防')}
        ${minRow('lingxing', '灵性值')}`,
      },
      {
        id: 'neidan', title: '内丹', body: `
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">高级内丹</span>${chips('high_neidan', PET.highNeidans)}</div>
        ${minRow('high_neidan_level', '高级内丹层数')}
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">低级内丹</span>${chips('low_neidan', PET.lowNeidans)}</div>
        ${minRow('low_neidan_level', '低级内丹层数')}`,
      },
      {
        id: 'texing', title: '特性与外观', body: `
        <div class="fld-row" style="flex-direction:column;align-items:stretch"><span class="f-label">特性</span>${chips('texing', PET.texingTypes)}</div>
        <div class="fld-row"><span class="f-label">正面效果</span>${chips('positive_effect', PET.effectLevels)}</div>
        <div class="fld-row"><span class="f-label">负面效果</span>${chips('negative_effect', PET.effectLevels)}</div>
        <div class="fld-row"><span class="f-label">梦影</span>${chips('mengying', PET.mengying)}</div>
        <div class="fld-row"><span class="f-label">幻色丹染色</span>${chips('summon_color', [['1', '包含']])}</div>`,
      },
      {
        id: 'price', title: '价格', body: `
        ${rangeRow('price', '价格', '元')}`,
      },
      {
        id: 'server', title: '服务器范围', body: `
        <div class="fld-row"><span class="f-label">选择服务器</span><div class="server-cascade" style="flex:1">
          <select id="f-area"><option value="">全服（不选服务器）</option>${SERVERS.map((a) => `<option value="${esc(a.area)}">${esc(a.area)}</option>`).join('')}</select>
          <select id="f-serverid" data-key="serverid"><option value="">全部服务器</option></select></div></div>
        <div class="fld-row"><span class="f-label">开服时间</span>${chips('server_type', [['3', '3年以上服'], ['2', '1到3年服'], ['1', '1年内服']])}</div>`,
      },
    ];

    $('cats').innerHTML = CATS.map((cat, i) => `
      <details class="cat" ${i === 0 ? 'open' : ''} id="cat-${cat.id}">
        <summary>${cat.title}<span class="cnt" id="cnt-${cat.id}"></span></summary>
        <div class="cat-body">${cat.body}</div>
      </details>`).join('');

    // 大区联动
    $('f-area').addEventListener('change', () => {
      const area = SERVERS.find((a) => a.area === $('f-area').value);
      $('f-serverid').innerHTML = '<option value="">全部服务器</option>' + (area ? area.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') : '');
    });

    // 通用事件委托
    $('cats').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        // 分组展开
        if (chip.classList.contains('skill-expand') || chip.closest('.skill-expand')) { return; }
        const row = chip.closest('[data-multi]');
        if (row || chip.hasAttribute('data-flag')) {
          // 只显示宝宝 / 幻色丹染色 / 满足全部 / 技能选项等单选型 flag：点按切换
          if (chip.hasAttribute('data-flag')) {
            const name = chip.getAttribute('data-flag');
            if (name === 'skill_with_suit' && !chip.classList.contains('on')) {
              const other = document.querySelector('.chip[data-flag="suit_as_any_skill"]');
              if (other) other.classList.remove('on');
            }
            if (name === 'suit_as_any_skill' && !chip.classList.contains('on')) {
              const other = document.querySelector('.chip[data-flag="skill_with_suit"]');
              if (other) other.classList.remove('on');
            }
          }
          chip.classList.toggle('on');
          updateCounters();
          return;
        }
      }
      const exp = e.target.closest('.skill-expand');
      if (exp) {
        const panel = exp.closest('.skill-panel');
        panel.querySelectorAll('.skill-group').forEach((g) => { g.style.display = ''; });
        exp.style.display = 'none';
      }
    });
    $('cats').addEventListener('change', updateCounters);
    $('cats').addEventListener('input', updateCounters);
  }

  /** 把当前方案的值写进表单 */
  function fillForm() {
    // 先清空
    document.querySelectorAll('#cats [data-key]').forEach((el) => { el.value = ''; });
    document.querySelectorAll('#cats .chip.on').forEach((c) => c.classList.remove('on'));
    const c = cur().criteria || {};
    Object.keys(c).forEach((k) => {
      let v = c[k];
      if (/^price_(min|max)$/.test(k)) v = String(Number(v) / 100);
      if (k === 'growth') v = String(Number(v) / 1000);
      if (k === 'type') { // id 列表 → 名称
        const hit = PET.petNames.find((n) => n[1] === String(v));
        const el = $('f-type');
        if (el) el.value = hit ? hit[0] : String(v);
        return;
      }
      if (k === 'serverid') {
        let hit = null;
        SERVERS.forEach((a) => a.servers.forEach((s) => { if (String(s.id) === String(v)) hit = a; }));
        if (hit) {
          $('f-area').value = hit.area;
          $('f-serverid').innerHTML = '<option value="">全部服务器</option>' + hit.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
          $('f-serverid').value = String(v);
        }
        return;
      }
      const el = $('f-' + k);
      if (el) { el.value = v; return; }
      // 多选 / flag
      const row = document.querySelector(`#cats [data-key="${k}"][data-multi]`);
      if (row) {
        String(v).split(',').forEach((val) => {
          const ch = row.querySelector(`.chip[data-v="${CSS.escape(val)}"]`);
          if (ch) ch.classList.add('on');
        });
        return;
      }
      const flag = document.querySelector(`#cats .chip[data-flag="${k}"]`);
      if (flag && String(v) === '1') flag.classList.add('on');
    });
    updateCounters();
  }

  /** 从表单收集条件（官网 args 键名） */
  function collectCriteria() {
    const c = {};
    // 名称（→ id 列表）
    const nameVal = String($('f-type') ? $('f-type').value : '').trim();
    if (nameVal) {
      const hit = PET.petNames.find((n) => n[0] === nameVal);
      if (hit) c.type = hit[1];
      else c.type = nameVal; // 允许手填，接口侧按名称无效会返回空结果
    }
    // 数字/文本单值（growth 与 price 做单位换算）
    document.querySelectorAll('#cats [data-key]').forEach((el) => {
      const k = el.getAttribute('data-key');
      const v = String(el.value || '').trim();
      if (!v) return;
      if (/^price_(min|max)$/.test(k)) c[k] = String(Math.round(parseFloat(v) * 100));
      else if (k === 'growth') {
        const g = parseFloat(v);
        if (!isNaN(g) && /^\d\.\d{1,3}$/.test(v)) c[k] = String(Math.round(g * 1000));
      } else c[k] = v;
    });
    // 多选组
    document.querySelectorAll('#cats [data-key][data-multi]').forEach((row) => {
      const k = row.getAttribute('data-key');
      const vals = [...row.querySelectorAll('.chip.on')].map((ch) => ch.getAttribute('data-v'));
      if (vals.length) c[k] = vals.join(',');
    });
    // flag 开关
    document.querySelectorAll('#cats .chip[data-flag]').forEach((ch) => {
      const k = ch.getAttribute('data-flag');
      const on = ch.classList.contains('on') ? '1' : '';
      if (k === 'evol_skill_mode') {
        if (c.evol_skill && ch.classList.contains('on')) c.evol_skill_mode = '1';
        return;
      }
      if (k === 'no_include_sp_skill') {
        if (Number(c.skill_num) > 0 && ch.classList.contains('on')) c.no_include_sp_skill = '1';
        return;
      }
      if (on && k !== 'is_baobao' && k !== 'summon_color') c[k] = '1';
      else if (on && (k === 'is_baobao' || k === 'summon_color')) c[k] = '1';
    });
    cur().criteria = c;
  }

  function updateCounters() {
    collectCriteria();
    const CAT_IDS = ['basic', 'skills', 'evol', 'overview', 'zizhi', 'attrs', 'neidan', 'texing', 'price', 'server'];
    const CAT_MAP = {
      basic: /^(type|kindid|level_|front_status|color|is_baobao)/,
      skills: /^(skill|not_in_skill|low_skill|skill_with_suit|suit_as_any_skill|skill_including_advanced|skill_num|no_include_sp_skill)/,
      evol: /^(evol_skill|evol_skill_mode|valid_evol_skill_num|advanced_evol_skill)/,
      overview: /^(growth|used_lianshou_max|used_yuanxiao_max)/,
      zizhi: /^(attack_aptitude|defence_aptitude|physical_aptitude|magic_aptitude|speed_aptitude_)/,
      attrs: /^(max_blood|attack|defence|speed_|fashang|fafang|lingxing)/,
      neidan: /^(high_neidan|low_neidan)/,
      texing: /^(texing|positive_effect|negative_effect|mengying|summon_color)/,
      price: /^price_/,
      server: /^(serverid|server_type)/,
    };
    const keys = Object.keys(cur().criteria);
    CAT_IDS.forEach((id) => {
      const el = $('cnt-' + id);
      if (!el) return;
      const re = CAT_MAP[id];
      // attack / defence / speed 同名键归属：attack/defence 精确匹配走 attrs，资质键带 _aptitude
      const n = keys.filter((k) => {
        if (id === 'attrs' && /^(attack|defence)$/.test(k)) return true;
        if (id === 'basic' && k === 'type') return true;
        if (id === 'basic' && k === 'is_baobao') return true;
        return re.test(k);
      }).length;
      el.textContent = n ? `${n} 项` : '';
    });
    const total = keys.length;
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
    const saveSummary = () => {
      const c = cur().criteria;
      const parts = [];
      if (c.type) {
        const hit = PET.petNames.find((n) => n[1] === c.type);
        parts.push('名称:' + (hit ? hit[0] : c.type));
      }
      if (c.serverid) {
        let srv = null;
        SERVERS.forEach((a) => a.servers.forEach((s) => { if (String(s.id) === String(c.serverid)) srv = a.name + '-' + s.name; }));
        parts.push('区服:' + (srv || c.serverid));
      }
      if (c.price_max) parts.push('≤' + parseInt(c.price_max, 10) / 100 + '元');
      if (c.skill_num) parts.push('技能≥' + c.skill_num);
      if (c.skill) parts.push('含' + c.skill.split(',').length + '技能');
      if (c.growth) parts.push('成长≥' + Number(c.growth) / 1000);
      if (c.is_baobao) parts.push('仅宝宝');
      return '已保存（' + (parts.join(' · ') || '无条件，搜全部') + '）';
    };
    $('btn-save-local').addEventListener('click', () => { collectCriteria(); saveLocal(); toast(saveSummary()); updateCounters(); });
    $('btn-save-cloud').addEventListener('click', async () => {
      collectCriteria(); saveLocal();
      if ($('f-area') && $('f-area').value && !$('f-serverid').value) toast('⚠️ 已选大区但未选具体服务器，区服条件未生效');
      $('btn-save-cloud').disabled = true;
      const ok = await pushCloud();
      $('btn-save-cloud').disabled = false;
      if (ok !== false) toast(saveSummary());
    });
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
