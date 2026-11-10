/** 应用逻辑：状态管理、录入绑定、实时估值、导入与导出 */
(function () {
  const CFG = window.MHY_DEFAULT_CONFIG;
  const Engine = window.MHYEngine;
  const cbg = window.MHY.cbg;
  const STORE = 'mhy-valuator-web-v1';

  const emptyChar = () => ({
    level: '', sect: '', totalExpYi: '', huaShengLayers: '', jiYuan: '',
    qianYuanDan: '', potentialFruitCount: '', shenQiPoints: '', shouShu: '',
    renXiu: { gong: '', fang: '', fa: '', kang: '' },
    chongXiu: { gong: '', fang: '', fa: '', kang: '' },
    skills: ['', '', '', '', '', '', ''],
    qiangZhuang: '', shenSu: '',
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
  };

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
      localStorage.setItem(STORE, JSON.stringify({
        character: state.character,
        counts: state.counts,
        params: state.params,
        tiers: state.tiers,
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
    } catch (e) { /* 忽略损坏数据 */ }
  }

  // ---------- 渲染：技能输入 ----------
  function renderSkillGrid() {
    const grid = document.getElementById('skill-grid');
    grid.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = `技能 ${i + 1}`;
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
      const v = getPath(state.character, el.dataset.num);
      el.value = v === undefined || v === null ? '' : v;
    });
    document.querySelectorAll('[data-text]').forEach((el) => {
      const v = getPath(state.character, el.dataset.text);
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
  }

  // ---------- 录入绑定 ----------
  function bindInputs() {
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset && el.dataset.num) {
        setPath(state.character, el.dataset.num, el.value === '' ? '' : Number(el.value));
        recalc(); save();
      } else if (el.dataset && el.dataset.text) {
        setPath(state.character, el.dataset.text, el.value);
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
    const numeric = ['level', 'totalExpYi', 'huaShengLayers', 'jiYuan', 'qianYuanDan', 'potentialFruitCount', 'shenQiPoints', 'shouShu', 'qiangZhuang', 'shenSu'];
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
    renderResult(res);
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
    document.getElementById('btn-detail').onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-result'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  // ---------- 导入 ----------
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
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
    document.getElementById('btn-clear-import').onclick = () => { text.value = ''; msg.textContent = ''; };

    document.getElementById('btn-do-import').onclick = () => {
      msg.className = 'msg';
      msg.textContent = '解析中…';
      try {
        const r = cbg.importFromText(text.value);
        const ch = r.character;
        Object.keys(ch).forEach((k) => {
          if (k === 'renXiu' || k === 'chongXiu') {
            state.character[k] = Object.assign({ gong: '', fang: '', fa: '', kang: '' }, ch[k]);
          } else {
            state.character[k] = ch[k];
          }
        });
        syncInputs();
        recalc();
        save();
        msg.className = 'msg ok';
        msg.textContent = `已填入：${r.filled.join('、') || '（无）'}\n` + (r.warnings.length ? '待补填：' + r.warnings.join('；') : '');
      } catch (e) {
        msg.className = 'msg err';
        msg.textContent = '解析失败：' + e.message;
      }
    };
  }

  // ---------- 快捷操作 ----------
  const DEMO = {
    level: 175, sect: '阴曹地府', totalExpYi: 774, huaShengLayers: 9, jiYuan: 1,
    qianYuanDan: 9, potentialFruitCount: 200, shenQiPoints: 8, shouShu: 0,
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
      syncInputs(); renderCounters(); recalc(); save();
    };
    document.getElementById('btn-clear').onclick = () => {
      if (!confirm('确定清空全部录入内容？（参数设置不受影响）')) return;
      state.character = emptyChar();
      state.counts = { equip: {}, lingshi: {}, pet: {}, child: {} };
      syncInputs(); renderCounters(); recalc(); save();
    };
    document.getElementById('btn-add-mount').onclick = () => {
      state.character.mounts.push({ growth: '' });
      renderMounts(); save();
    };
    document.getElementById('btn-reset-params').onclick = () => {
      if (!confirm('恢复默认参数（金价、折现、档位价格等）？')) return;
      state.params = clone(CFG.params);
      state.tiers = clone(CFG.tiers);
      syncInputs(); renderCounters(); renderPriceGrid(); recalc(); save();
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
  syncInputs();
  recalc();
})();
