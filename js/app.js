/** 应用逻辑：状态管理、录入绑定、实时估值、导入与导出 */
(function () {
  const CFG = window.MHY_DEFAULT_CONFIG;
  const Engine = window.MHYEngine;
  const cbg = window.MHY.cbg;
  const STORE = 'mhy-valuator-web-v1';

  const emptyChar = () => ({
    level: '', sect: '', totalExpYi: '', huaShengLayers: '', jiYuan: '',
    jiYuanEat: '', jiYuanBase: '', jiYuanCap: '',
    qianYuanDan: '', potentialFruitCount: '', shouShu: '', salePrice: '',
    jinYiCount: '', xiangRuiCount: '', teXiaoCount: '', cangJieLevel: '',
    houseType: '', houseFengShui: '', houseDesc: '',
    renXiu: { gong: '', fang: '', fa: '', kang: '' },
    chongXiu: { gong: '', fang: '', fa: '', kang: '' },
    skills: ['', '', '', '', '', '', ''],
    skillNames: [],
    qiangZhuang: '', shenSu: '', yuShouShu: '',
    mounts: [],
  });

  const clone = (o) => JSON.parse(JSON.stringify(o));

  const state = {
    character: emptyChar(),
    counts: { equip: {}, lingshi: {}, pet: {}, child: {} },
    params: clone(CFG.params),
    tiers: clone(CFG.tiers),
    tables: CFG.tables,
    result: null,
    cloudRev: 0,
    cloud: null,
  };

  // ---------- 云端参数（站点同源 params.json）----------
  const CLOUD_FILE = 'params.json';
  const TOKEN_KEY = 'mhy-gh-token';

  /** 浅层对象深合并：云端值覆盖默认值，默认值补齐云端缺失的键 */
  function mergeDeep(base, over) {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
    const out = Object.assign({}, base);
    Object.keys(over).forEach((k) => {
      const b = base == null ? undefined : base[k];
      const o = over[k];
      if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) {
        out[k] = mergeDeep(b, o);
      } else if (o !== undefined) {
        out[k] = o;
      }
    });
    return out;
  }

  /** 自动识别 GitHub 仓库（owner/repo）；非 github.io 时用默认值 */
  function cloudRepo() {
    const host = location.hostname || '';
    if (/\.github\.io$/i.test(host)) {
      const owner = host.split('.')[0];
      const repo = (location.pathname.split('/').filter(Boolean)[0] || '').replace(/\.git$/, '');
      if (owner && repo) return owner + '/' + repo;
    }
    return 'peng-113/MHXYGJ';
  }

  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function setCloudStatus(txt, cls) {
    const el = document.getElementById('cloud-status');
    if (!el) return;
    el.textContent = txt;
    el.className = 'hint cloud-status' + (cls ? ' ' + cls : '');
  }

  /** 拉取云端参数；rev 比本地新（或 force）时采用 */
  async function pullCloud(force) {
    const res = await fetch(CLOUD_FILE + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const rev = Number(d.rev) || 0;
    state.cloud = { rev, updatedAt: d.updatedAt || '' };
    const localRev = Number(state.cloudRev) || 0;
    if (force || rev > localRev) {
      state.params = mergeDeep(clone(CFG.params), d.params || {});
      state.tiers = mergeDeep(clone(CFG.tiers), d.tiers || {});
      state.cloudRev = rev;
      syncInputs();
      renderCounters();
      renderPriceGrid();
      recalc();
      save();
      return { adopted: true, rev };
    }
    return { adopted: false, rev };
  }

  async function refreshCloudUI(force) {
    try {
      const r = await pullCloud(!!force);
      const when = state.cloud && state.cloud.updatedAt
        ? new Date(state.cloud.updatedAt).toLocaleString('zh-CN', { hour12: false })
        : '';
      setCloudStatus(r.adopted
        ? `已采用云端参数（版本 ${r.rev}${when ? '，更新于 ' + when : ''}）。换设备/换浏览器打开会自动同步。`
        : `参数已是最新（云端版本 ${r.rev}${when ? '，更新于 ' + when : ''}）。`, 'ok');
    } catch (e) {
      setCloudStatus('云端参数读取失败（' + e.message + '），当前使用本机参数。', 'err');
    }
  }

  /** 把当前参数写回云端 params.json（需 GitHub Token，仅本机保存） */
  async function pushCloud() {
    const input = document.getElementById('cloud-token');
    const msg = document.getElementById('cloud-push-msg');
    const token = ((input && input.value) || localStorage.getItem(TOKEN_KEY) || '').trim();
    if (!token) throw new Error('请先填入 GitHub Token');
    const repo = cloudRepo();
    const api = `https://api.github.com/repos/${repo}/contents/${CLOUD_FILE}`;
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    };
    const body = {
      rev: Date.now(),
      updatedAt: new Date().toISOString(),
      params: state.params,
      tiers: state.tiers,
    };
    const content = b64utf8(JSON.stringify(body, null, 2) + '\n');

    const g = await fetch(api + '?ref=main&t=' + Date.now(), { headers });
    let sha;
    if (g.ok) {
      sha = (await g.json()).sha;
    } else if (g.status !== 404) {
      throw new Error('读取云端文件失败 HTTP ' + g.status + (g.status === 401 || g.status === 403 ? '（Token 无效或权限不足）' : ''));
    }

    const r = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ message: '更新估值参数（网页保存）', content, sha, branch: 'main' }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error('保存失败 HTTP ' + r.status + '：' + t.slice(0, 140));
    }
    localStorage.setItem(TOKEN_KEY, token);
    state.cloudRev = body.rev;
    state.cloud = { rev: body.rev, updatedAt: body.updatedAt };
    save();
    if (msg) msg.textContent = '已提交到 GitHub（版本 ' + body.rev + '）。其他设备约 1 分钟后刷新即可拿到新参数。';
  }

  // ---------- 路径读写 ----------
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = val;
  }
  /** 输入框上的 data-num / data-text 形如 character.level，
   *  但读写对象已经是 state.character，需去掉这层前缀 */
  const relPath = (p) => String(p || '').replace(/^character\./, '');

  // ---------- 工具 ----------
  const fmtMoney = (n) => '¥' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = (n) => (Math.round(Number(n) || 0)).toLocaleString('zh-CN');
  const toNum = (v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    return isFinite(n) ? n : undefined;
  };

  // ---------- 存储 ----------
  function save() {
    try {
      const note = document.getElementById('import-note');
      localStorage.setItem(STORE, JSON.stringify({
        character: state.character,
        counts: state.counts,
        params: state.params,
        tiers: state.tiers,
        cloudRev: state.cloudRev,
        importNote: note && !note.hidden ? note.textContent : '',
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.character) state.character = Object.assign(emptyChar(), d.character);
      if (d.counts) state.counts = Object.assign({ equip: {}, lingshi: {}, pet: {}, child: {} }, d.counts);
      if (d.params) state.params = d.params;
      if (d.tiers) state.tiers = d.tiers;
      if (d.cloudRev) state.cloudRev = Number(d.cloudRev) || 0;
      if (d.importNote) {
        const note = document.getElementById('import-note');
        if (note) { note.textContent = d.importNote; note.hidden = false; }
      }
    } catch (e) { /* 忽略损坏数据 */ }
  }

  // ---------- 渲染：技能输入 ----------
  function renderSkillGrid() {
    const grid = document.getElementById('skill-grid');
    grid.innerHTML = '';
    const names = state.character.skillNames || [];
    for (let i = 0; i < 7; i++) {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = names[i] ? `${names[i]}` : `技能 ${i + 1}`;
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = '0';
      input.max = '180';
      input.placeholder = '180';
      input.dataset.num = `character.skills.${i}`;
      label.appendChild(span);
      label.appendChild(input);
      grid.appendChild(label);
    }
  }

  // ---------- 渲染：档位计数 ----------
  const TABS = [
    { key: 'equip', name: '装备', rules: () => state.tiers.equipment || [] },
    { key: 'lingshi', name: '灵饰', rules: () => state.tiers.lingshi || [] },
    { key: 'pet', name: '召唤兽', rules: () => state.tiers.petTiers || [] },
    { key: 'child', name: '孩子', rules: () => state.tiers.childTiers || [] },
  ];

  function tierLabel(rule) {
    return rule.minSkills !== undefined && rule.minSkills > 0
      ? `${rule.tier}（≥${rule.minSkills} 技能）`
      : rule.tier;
  }

  function renderCounters() {
    TABS.forEach((t) => {
      const box = document.getElementById('counter-' + t.key);
      if (!box) return;
      box.innerHTML = '';
      t.rules().forEach((rule) => {
        const n = Number(state.counts[t.key][rule.tier]) || 0;
        const row = document.createElement('div');
        row.className = 'counter';

        const left = document.createElement('div');
        const nm = document.createElement('span');
        nm.className = 'c-name';
        nm.textContent = tierLabel(rule);
        const pr = document.createElement('span');
        pr.className = 'c-price';
        pr.textContent = '¥' + fmtInt(rule.price);
        left.appendChild(nm);
        left.appendChild(pr);

        const ctrl = document.createElement('div');
        ctrl.className = 'c-ctrl';
        const minus = document.createElement('button');
        minus.textContent = '−';
        minus.setAttribute('aria-label', '减少');
        const val = document.createElement('span');
        val.className = 'c-val';
        val.textContent = n;
        const plus = document.createElement('button');
        plus.textContent = '+';
        plus.setAttribute('aria-label', '增加');

        minus.onclick = () => {
          const cur = Number(state.counts[t.key][rule.tier]) || 0;
          state.counts[t.key][rule.tier] = Math.max(0, cur - 1);
          renderCounters(); recalc(); save();
        };
        plus.onclick = () => {
          const cur = Number(state.counts[t.key][rule.tier]) || 0;
          state.counts[t.key][rule.tier] = cur + 1;
          renderCounters(); recalc(); save();
        };

        ctrl.appendChild(minus);
        ctrl.appendChild(val);
        ctrl.appendChild(plus);
        row.appendChild(left);
        row.appendChild(ctrl);
        box.appendChild(row);
      });
    });
  }

  // ---------- 渲染：档位价格（参数页） ----------
  function renderPriceGrid() {
    const grid = document.getElementById('price-grid');
    grid.innerHTML = '';
    TABS.forEach((t) => {
      t.rules().forEach((rule) => {
        const label = document.createElement('label');
        label.className = 'field';
        const span = document.createElement('span');
        span.textContent = `${t.name} ${rule.tier}`;
        const input = document.createElement('input');
        input.type = 'number';
        input.inputMode = 'numeric';
        input.dataset.price = `${t.key}.${rule.tier}`;
        input.value = rule.price;
        label.appendChild(span);
        label.appendChild(input);
        grid.appendChild(label);
      });
    });
  }

  // ---------- 渲染：坐骑 ----------
  function renderMounts() {
    const box = document.getElementById('mount-list');
    box.innerHTML = '';
    if (!state.character.mounts.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.margin = '0 0 4px';
      p.textContent = '暂无坐骑，点击下方按钮添加。';
      box.appendChild(p);
      return;
    }
    state.character.mounts.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'mount-row';
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.step = '0.01';
      input.placeholder = '成长值，如 2.3137';
      input.dataset.mount = String(i);
      input.value = m.growth;
      const del = document.createElement('button');
      del.textContent = '×';
      del.setAttribute('aria-label', '删除坐骑');
      del.onclick = () => {
        state.character.mounts.splice(i, 1);
        renderMounts(); recalc(); save();
      };
      row.appendChild(input);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  // ---------- 输入同步 ----------
  function syncInputs() {
    document.querySelectorAll('[data-num]').forEach((el) => {
      const v = getPath(state.character, relPath(el.dataset.num));
      el.value = v === undefined || v === null ? '' : v;
    });
    document.querySelectorAll('[data-text]').forEach((el) => {
      const v = getPath(state.character, relPath(el.dataset.text));
      el.value = v === undefined || v === null ? '' : v;
    });
    document.querySelectorAll('[data-param]').forEach((el) => {
      const v = getPath(state.params, el.dataset.param);
      el.value = v === undefined || v === null ? '' : v;
    });
    document.querySelectorAll('[data-price]').forEach((el) => {
      const [tab, tier] = el.dataset.price.split('.');
      const rule = (TABS.find((t) => t.key === tab).rules() || []).find((r) => r.tier === tier);
      if (rule) el.value = rule.price;
    });
    renderMounts();
    // 机缘标签：拿到上限时显示 40/69 形式
    const jyLabel = document.getElementById('jiyuan-label');
    if (jyLabel) {
      const cap = state.character.jiYuanCap;
      jyLabel.textContent = cap ? `机缘（点，上限 ${cap}）` : '机缘（点）';
    }
  }

  // ---------- 录入绑定 ----------
  function bindInputs() {
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset && el.dataset.num) {
        setPath(state.character, relPath(el.dataset.num), el.value === '' ? '' : Number(el.value));
        recalc(); save();
      } else if (el.dataset && el.dataset.text) {
        setPath(state.character, relPath(el.dataset.text), el.value);
        recalc(); save();
      } else if (el.dataset && el.dataset.param) {
        setPath(state.params, el.dataset.param, el.value === '' ? '' : Number(el.value));
        recalc(); save();
      } else if (el.dataset && el.dataset.price) {
        const [tab, tier] = el.dataset.price.split('.');
        const rule = (TABS.find((t) => t.key === tab).rules() || []).find((r) => r.tier === tier);
        if (rule) {
          rule.price = Number(el.value) || 0;
          renderCounters(); recalc(); save();
        }
      } else if (el.dataset && el.dataset.mount !== undefined) {
        const i = Number(el.dataset.mount);
        if (state.character.mounts[i]) {
          state.character.mounts[i].growth = el.value === '' ? '' : Number(el.value);
          recalc(); save();
        }
      }
    });
  }

  // ---------- 估值 ----------
  function buildCharacter() {
    const c = clone(state.character);
    const numeric = [
      'level', 'totalExpYi', 'huaShengLayers', 'jiYuan', 'qianYuanDan', 'potentialFruitCount',
      'shouShu', 'qiangZhuang', 'shenSu', 'yuShouShu', 'salePrice',
      'jinYiCount', 'xiangRuiCount', 'teXiaoCount', 'cangJieLevel',
    ];
    numeric.forEach((k) => { if (c[k] === '' || c[k] === null) c[k] = undefined; });
    ['renXiu', 'chongXiu'].forEach((g) => {
      if (!c[g]) return;
      Object.keys(c[g]).forEach((k) => { if (c[g][k] === '') c[g][k] = undefined; });
    });
    if (Array.isArray(c.skills)) {
      c.skills = c.skills.filter((v) => v !== '' && v !== null && v !== undefined && isFinite(Number(v))).map(Number);
    }
    c.mounts = (c.mounts || []).filter((m) => m && m.growth !== '' && isFinite(Number(m.growth)))
      .map((m) => ({ growth: Number(m.growth) }));
    c.tierCounts = state.counts;
    return c;
  }

  function recalc() {
    let res;
    try {
      res = Engine.estimate(buildCharacter(), state.params, state.tiers, state.tables);
    } catch (e) {
      console.error(e);
      return;
    }
    state.result = res;
    document.getElementById('total').textContent = '¥' + fmtInt(res.total);
    const miss = res.missing.length;
    document.getElementById('missing-count').textContent = miss ? `${miss} 项待填` : '全部已填';
    renderSaleLine(res);
    renderResult(res);
  }

  /** 底部：售价 + 折扣（折扣 = 售价 / 估值合计） */
  function renderSaleLine(res) {
    const el = document.getElementById('sum-price');
    if (!el) return;
    if (!res.salePrice) {
      el.textContent = '售价 — · 折扣 —';
      return;
    }
    const price = '¥' + fmtInt(res.salePrice);
    if (res.discount === null || res.discount === undefined) {
      el.innerHTML = `售价 <b>${price}</b> · 折扣 —`;
      return;
    }
    const pct = (res.discount * 100).toFixed(1) + '%';
    const cls = res.discount <= 1 ? 'dis-good' : 'dis-bad';
    el.innerHTML = `售价 <b>${price}</b> · 折扣 <span class="${cls}">${pct}</span>`;
  }

  function renderResult(res) {
    const box = document.getElementById('result-list');
    box.innerHTML = '';
    res.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'result-item' + (it.status === 'missing' ? ' missing' : '');
      const left = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'r-name';
      nm.textContent = it.name;
      const bs = document.createElement('div');
      bs.className = 'r-basis';
      bs.textContent = it.status === 'missing' ? '未填写，未计入' : it.basis;
      left.appendChild(nm);
      left.appendChild(bs);
      const v = document.createElement('div');
      v.className = 'r-val';
      v.textContent = fmtMoney(it.value);
      row.appendChild(left);
      row.appendChild(v);
      box.appendChild(row);
    });
  }

  // ---------- 标签切换 ----------
  function bindTabs() {
    document.getElementById('tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
      document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + btn.dataset.tab));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // 明细：从底部向上展开的抽屉，不替换当前页面内容
    const drawer = document.getElementById('detail-drawer');
    const btnDetail = document.getElementById('btn-detail');
    const setDrawer = (open) => {
      drawer.classList.toggle('open', open);
      document.body.classList.toggle('drawer-open', open);
      btnDetail.textContent = open ? '收起' : '明细';
      if (open) {
        const inner = drawer.querySelector('.drawer-inner');
        if (inner) inner.scrollTop = 0;
      }
    };
    btnDetail.onclick = () => setDrawer(!drawer.classList.contains('open'));
    document.getElementById('btn-close-detail').onclick = () => setDrawer(false);
  }

  // ---------- 导入 ----------
  // ---------- 导入（粘贴源码 / 书签带参） ----------
  /** 把导入文本解码并填入当前角色，返回 { filled, warnings } */
  function applyImport(rawText) {
    const r = cbg.importFromText(rawText);
    const ch = r.character;
    Object.keys(ch).forEach((k) => {
      if (k === 'renXiu' || k === 'chongXiu') {
        state.character[k] = Object.assign({ gong: '', fang: '', fa: '', kang: '' }, ch[k]);
      } else {
        state.character[k] = ch[k];
      }
    });
    renderSkillGrid();
    syncInputs();
    recalc();
    save();
    const summary = `已填入 ${r.filled.length} 项：${r.filled.join('、')}` +
      (r.warnings.length ? `\n待补填：${r.warnings.join('；')}` : '');
    const note = document.getElementById('import-note');
    if (note) { note.textContent = summary.replace(/\n/g, '｜'); note.hidden = false; }
    // 导入完回到基础页，让用户直接看到数值
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'basic'));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-basic'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return { summary, warnings: r.warnings };
  }

  /** 书签小工具代码：在藏宝阁页面读取密文、机缘上限与售价，带参打开本站 */
  function buildBookmarklet() {
    const site = location.origin + location.pathname;
    const code = [
      '(function(){',
      "var el=document.getElementById('equip_desc_value');",
      "if(!el){alert('没找到角色数据：请先登录藏宝阁、打开账号详情页，等页面显示等级/修炼信息后再点这个书签。');return;}",
      "var d=String(el.value||el.textContent||'').replace(/\\s+/g,'');",
      "var m=d.match(/@[^@]+@[A-Za-z0-9+/=]+@?/);",
      'if(m){d=m[0];}',
      "if(d.length<50){alert('角色数据为空：可能未登录或页面还没加载完，稍等几秒再点。');return;}",
      "var j='';",
      "var t=(document.body.innerText||'').replace(/\\s+/g,' ');",
      "var mm=t.match(/月饼粽子机缘[：:]\\s*(\\d+)\\s*\\/\\s*(\\d+)/);",
      'if(mm){j=mm[1]+"/"+mm[2];}',
      // 售价：优先页面内嵌数据里的 "price"（本商品），再退回带 ￥ 的价格元素
      "var pr='';",
      'try{var html=document.documentElement.outerHTML;',
      "var p1=html.match(/\"price\"\\s*:\\s*['\"]?\\s*(\\d+(?:\\.\\d+)?)/);",
      'if(p1&&Number(p1[1])>0){pr=p1[1];}}catch(e){}',
      'if(!pr){try{var nodes=document.querySelectorAll("[class*=price]");',
      "for(var i=0;i<nodes.length;i++){var tx=(nodes[i].textContent||'').replace(/\\s+/g,'');",
      "var p2=tx.match(/[￥¥]([\\d,]+(?:\\.\\d+)?)/);",
      "if(p2){pr=p2[1].replace(/,/g,'');break;}}}catch(e){}}",
      "var p=encodeURIComponent(JSON.stringify({d:d,j:j,p:pr}));",
      "window.open('" + site + "#mhy='+p,'_blank');",
      '})()',
    ].join('');
    return 'javascript:' + code;
  }

  /** 从地址栏 #mhy=... 导入（书签小工具带过来的数据） */
  function importFromHash() {
    const m = (location.hash || '').match(/[#&]mhy=([^&]+)/);
    if (!m) return false;
    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(m[1]));
    } catch (e) { return false; }
    if (!payload || !payload.d) return false;
    const textVal = payload.d
      + (payload.j ? '\n月饼粽子机缘：' + payload.j : '')
      + (payload.p ? '\n售价：' + payload.p : '');
    try {
      applyImport(textVal);
    } catch (e) {
      alert('书签导入失败：' + e.message + '\n可改用“粘贴页面源码”方式。');
      return false;
    }
    // 清掉地址栏里的数据，避免刷新重复导入、也避免链接被误分享
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return true;
  }

  // ---------- 云端同步按钮 ----------
  function bindCloud() {
    const edit = document.getElementById('btn-cloud-edit');
    if (edit) edit.href = `https://github.com/${cloudRepo()}/edit/main/${CLOUD_FILE}`;

    const pull = document.getElementById('btn-cloud-pull');
    if (pull) {
      pull.onclick = async () => {
        pull.disabled = true;
        setCloudStatus('正在从云端拉取参数…');
        try { await refreshCloudUI(true); } catch (e) { setCloudStatus('拉取失败：' + e.message, 'err'); }
        pull.disabled = false;
      };
    }

    const push = document.getElementById('btn-cloud-push');
    const msg = document.getElementById('cloud-push-msg');
    if (push) {
      push.onclick = async () => {
        push.disabled = true;
        if (msg) msg.textContent = '正在提交到 GitHub…';
        try {
          await pushCloud();
          if (msg) msg.className = 'hint ok';
        } catch (e) {
          if (msg) { msg.className = 'hint err'; msg.textContent = '保存失败：' + e.message; }
        }
        push.disabled = false;
      };
    }

    const forget = document.getElementById('btn-cloud-forget');
    if (forget) {
      forget.onclick = () => {
        localStorage.removeItem(TOKEN_KEY);
        const input = document.getElementById('cloud-token');
        if (input) input.value = '';
        if (msg) { msg.className = 'hint'; msg.textContent = '已清除本机保存的 Token。'; }
      };
    }
  }

  function bindImport() {
    const modal = document.getElementById('import-modal');
    const msg = document.getElementById('import-msg');
    const text = document.getElementById('import-text');

    document.getElementById('btn-import').onclick = () => {
      modal.hidden = false;
      msg.textContent = '';
      msg.className = 'msg';
    };
    document.getElementById('btn-close-import').onclick = () => { modal.hidden = true; };
    // 故意不做“点背景关闭”：在 textarea 里选中文字后把鼠标拖到框外松开，
    // 浏览器会在背景元素上补发一次 click，导致弹窗被误关。只允许按钮关闭。
    document.getElementById('btn-clear-import').onclick = () => { text.value = ''; msg.textContent = ''; };

    // 书签小工具：直接把代码写到链接上，用户拖到书签栏即可
    const bm = buildBookmarklet();
    const bmLink = document.getElementById('bm-link');
    if (bmLink) bmLink.setAttribute('href', bm);
    const bmCopy = document.getElementById('bm-copy');
    if (bmCopy) {
      bmCopy.onclick = async () => {
        const tip = document.getElementById('bm-tip');
        try {
          await navigator.clipboard.writeText(bm);
          if (tip) tip.textContent = '书签代码已复制。新建一个书签，把网址粘贴进去即可（名称随意，如“导入藏宝阁”）。';
        } catch (e) {
          if (tip) tip.textContent = '复制失败，请右键上面的按钮 →“复制链接地址”，或手动新建书签粘贴。';
        }
      };
    }

    document.getElementById('btn-do-import').onclick = () => {
      msg.className = 'msg';
      msg.textContent = '解析中…';
      try {
        const { summary } = applyImport(text.value);
        msg.className = 'msg ok';
        msg.textContent = summary;
        // 成功即关闭弹窗，让用户直接看到已填入的数值
        setTimeout(() => { modal.hidden = true; }, 900);
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = '解析失败：' + e.message;
      }
    };
  }

  // ---------- 快捷操作 ----------
  const DEMO = {
    level: 175, sect: '阴曹地府', totalExpYi: 774, huaShengLayers: 9, jiYuan: 1,
    qianYuanDan: 9, potentialFruitCount: 200, shouShu: 0, salePrice: 16999,
    jinYiCount: 44, xiangRuiCount: 9, teXiaoCount: 1, cangJieLevel: 28,
    houseType: '豪宅', houseFengShui: '紫气东来',
    renXiu: { gong: 1, fang: 25, fa: 25, kang: 25 },
    chongXiu: { gong: 25, fang: 20, fa: 23, kang: 20 },
    skills: [180, 180, 180, 180, 180, 180, 180],
    qiangZhuang: 45, shenSu: 45,
    mounts: [{ growth: 2.35 }],
  };

  function bindQuick() {
    document.getElementById('btn-demo').onclick = () => {
      state.character = Object.assign(emptyChar(), clone(DEMO));
      state.counts = { equip: { T2: 2 }, lingshi: { T2: 1 }, pet: { A: 1 }, child: {} };
      renderSkillGrid(); syncInputs(); renderCounters(); recalc(); save();
    };
    document.getElementById('btn-clear').onclick = () => {
      if (!confirm('确定清空全部录入内容？（参数设置不受影响）')) return;
      state.character = emptyChar();
      state.counts = { equip: {}, lingshi: {}, pet: {}, child: {} };
      const note = document.getElementById('import-note');
      if (note) note.hidden = true;
      renderSkillGrid(); syncInputs(); renderCounters(); recalc(); save();
    };
    document.getElementById('btn-add-mount').onclick = () => {
      state.character.mounts.push({ growth: '' });
      renderMounts(); save();
    };
    document.getElementById('btn-reset-params').onclick = async () => {
      if (!confirm('恢复参数为默认值？（若云端参数可读，会采用云端版本）')) return;
      state.params = clone(CFG.params);
      state.tiers = clone(CFG.tiers);
      syncInputs(); renderCounters(); renderPriceGrid(); recalc();
      try { await pullCloud(true); } catch (e) { save(); }
    };
  }

  // ---------- 导出 ----------
  function bindExport() {
    document.getElementById('btn-export').onclick = async () => {
      if (!state.result) return;
      try {
        await window.MHY.exportXlsx.download(buildCharacter(), state.params, state.result, { counts: state.counts });
      } catch (e) {
        alert('导出失败：' + e.message);
      }
    };
  }

  // ---------- 底部栏高度（供明细抽屉贴合定位） ----------
  function syncFooterHeight() {
    const f = document.querySelector('footer.summary');
    if (f) document.documentElement.style.setProperty('--footer-h', f.offsetHeight + 'px');
  }

  // ---------- 启动 ----------
  load();
  renderSkillGrid();
  renderCounters();
  renderPriceGrid();
  bindInputs();
  bindTabs();
  bindImport();
  bindQuick();
  bindExport();
  bindCloud();
  // 书签小工具带参进来：先导入，再渲染初始态（确保覆盖本地缓存）
  const fromBookmark = importFromHash();
  syncInputs();
  syncFooterHeight();
  window.addEventListener('resize', syncFooterHeight);
  window.addEventListener('orientationchange', syncFooterHeight);
  recalc();
  refreshCloudUI();
})();
