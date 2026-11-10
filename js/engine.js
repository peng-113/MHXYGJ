/**
 * 估值引擎（浏览器 / Node 双用）
 * 口径：成本项按"已投入成本"折算（0 级 → 当前等级的官方累计消耗）
 * 数据：params / tiers / tables 由调用方传入（网页从 localStorage 或 config-data.js 取）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MHYEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** 几何插值：按累计总量 total、级数 n、公比 r 生成累计消耗，cum[i] = 升到第 i+1 级的累计 */
  function buildCumGeo(total, n, r) {
    const sum = (Math.pow(r, n) - 1) / (r - 1);
    const c = total / sum;
    const cum = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += c * Math.pow(r, i);
      cum.push(acc);
    }
    return cum;
  }

  /** 已投入消耗：给定累计表与当前等级，返回 0 级升到当前等级的累计消耗 */
  function intervalCost(cum, current) {
    const max = cum.length;
    const cur = Math.max(0, Math.min(Math.floor(current), max));
    return cur > 0 ? cum[cur - 1] : 0;
  }

  /** 师门技能已投入消耗：优先官方逐级精确表 skillCumWan，缺失时退回锚点插值 */
  function skillIntervalCost(tables, current, target) {
    if (Array.isArray(tables.skillCumWan) && tables.skillCumWan.length) {
      const max = tables.skillCumWan.length;
      const t2 = Math.min(Math.max(target || max, current), max);
      return intervalCost(tables.skillCumWan.slice(0, t2), current);
    }
    const low = tables.skillLow;
    const high = tables.skillHighAnchor;
    const cumLow = buildCumGeo(low.cumTotal, low.toLevel, low.curve);
    const cumHigh = buildCumGeo(high.cumTotal, high.toLevel - high.fromLevel, high.curve);
    const target2 = Math.min(Math.max(target, current), high.toLevel);
    let cost = 0;
    const lowEnd = Math.min(target2, low.toLevel);
    cost += intervalCost(cumLow.slice(0, lowEnd), current);
    if (target2 > low.toLevel) {
      cost += intervalCost(cumHigh, Math.max(0, current - low.toLevel));
    }
    return cost;
  }

  /** 档位判定：关键词从上到下首次命中 */
  function classifyByKeywords(name, rules) {
    const text = (name || '').toString();
    for (const rule of rules) {
      for (const kw of rule.keywords || []) {
        if (kw && text.includes(kw)) return rule.tier;
      }
    }
    return null;
  }

  function classifyPet(pet, tiers) {
    const specials = tiers.specialSkillKeywords || [];
    const text = [pet.name, ...(pet.specialTags || [])].join('|');
    if (specials.some((kw) => text.includes(kw))) return 'S';
    for (const t of tiers.petTiers || []) {
      if ((pet.skillCount || 0) >= (t.minSkills || 0)) return t.tier;
    }
    return null;
  }

  function classifyChild(child, tiers) {
    const specials = tiers.specialSkillKeywords || [];
    const text = [child.name, ...(child.tags || [])].join('|');
    if (specials.some((kw) => text.includes(kw))) return 'S';
    for (const t of tiers.childTiers || []) {
      if ((child.skillCount || 0) >= (t.minSkills || 0)) return t.tier;
    }
    return null;
  }

  function fmt(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * 主入口：estimate(character, params, tiers, tables)
   * 返回 { total, items[], groups, missing[], unclassified[] }
   */
  function estimate(character, params, tiers, tables) {
    const items = [];
    const rate = params.goldRate;
    const disc = params.discounts || {};

    // ---- 1. 人物修炼 ----
    const renXiuNames = { gong: '攻击修炼', fang: '防御修炼', fa: '法术修炼', kang: '抗法修炼' };
    const cumAttack = Array.isArray(tables.renXiuAttackCumWan) && tables.renXiuAttackCumWan.length
      ? tables.renXiuAttackCumWan : buildCumGeo(tables.renXiuAttack.cumTotal, tables.renXiuAttack.target, tables.renXiuAttack.curve);
    const cumDefense = Array.isArray(tables.renXiuDefenseCumWan) && tables.renXiuDefenseCumWan.length
      ? tables.renXiuDefenseCumWan : buildCumGeo(tables.renXiuDefense.cumTotal, tables.renXiuDefense.target, tables.renXiuDefense.curve);
    for (const [k, name] of Object.entries(renXiuNames)) {
      const cur = character.renXiu ? character.renXiu[k] : undefined;
      if (cur === undefined || cur === null || cur === '') {
        items.push({ category: '人修', name, method: '成本折算', basis: '-', discount: disc.renXiu, value: 0, status: 'missing' });
        continue;
      }
      const cum = k === 'gong' || k === 'fa' ? cumAttack : cumDefense;
      const interval = intervalCost(cum, cur);
      items.push({
        category: '人修', name, method: '成本折算',
        basis: `${cur}级，累计消耗 ${fmt(interval)} 万两`,
        discount: disc.renXiu, value: fmt(interval * rate * disc.renXiu), status: 'ok',
      });
    }

    // ---- 2. 召唤兽修炼（修炼果折算）----
    const chongXiuNames = { gong: '攻击控制力', fang: '防御控制力', fa: '法术控制力', kang: '抗法控制力' };
    const cumChongExp = Array.isArray(tables.chongXiuExpCum) && tables.chongXiuExpCum.length
      ? tables.chongXiuExpCum : buildCumGeo(tables.chongXiuExp.cumTotal, tables.chongXiuExp.target, tables.chongXiuExp.curve);
    for (const [k, name] of Object.entries(chongXiuNames)) {
      const cur = character.chongXiu ? character.chongXiu[k] : undefined;
      if (cur === undefined || cur === null || cur === '') {
        items.push({ category: '宠修', name, method: '果子折算', basis: '-', discount: disc.chongXiu, value: 0, status: 'missing' });
        continue;
      }
      const exp = intervalCost(cumChongExp, cur);
      const fruits = Math.floor(exp / params.fruitExp);
      const wan = fruits * params.fruitPrice;
      items.push({
        category: '宠修', name, method: '果子折算',
        basis: `${cur}级，${fruits}个 × ${params.fruitPrice}万两`,
        discount: disc.chongXiu, value: fmt(wan * rate * disc.chongXiu), status: 'ok',
      });
    }

    // ---- 3. 师门技能 ----
    const skillLv = Array.isArray(character.skills) ? character.skills : [];
    skillLv.forEach((lv, i) => {
      const name = `师门技能 ${i + 1}`;
      if (lv === undefined || lv === null || lv === '') {
        items.push({ category: '技能', name, method: '成本折算', basis: '-', discount: disc.skill, value: 0, status: 'missing' });
        return;
      }
      const interval = skillIntervalCost(tables, lv, params.skillTarget || 180);
      items.push({
        category: '技能', name, method: '成本折算',
        basis: `${lv}级，累计消耗 ${fmt(interval)} 万两`,
        discount: disc.skill, value: fmt(interval * rate * disc.skill), status: 'ok',
      });
    });
    if (skillLv.length === 0) {
      items.push({ category: '技能', name: '师门技能', method: '成本折算', basis: '-', discount: disc.skill, value: 0, status: 'missing' });
    }

    // ---- 4. 乾元丹 ----
    const qyd = character.qianYuanDan;
    if (qyd === undefined || qyd === null || qyd === '') {
      items.push({ category: '乾元丹', name: '乾元丹', method: '成本折算', basis: '-', discount: disc.qianYuanDan, value: 0, status: 'missing' });
    } else {
      const cum = tables.qianYuanDanCum;
      const idx = Math.max(0, Math.min(Math.floor(qyd), cum.length));
      const wan = idx > 0 ? cum[idx - 1] : 0;
      items.push({
        category: '乾元丹', name: '乾元丹', method: '成本折算',
        basis: `${qyd}颗，累计消耗 ${fmt(wan)} 万两`,
        discount: disc.qianYuanDan, value: fmt(wan * rate * disc.qianYuanDan), status: 'ok',
      });
    }

    // ---- 5. 强壮 / 神速 ----
    const strongTable = tables.strongCumTotal || { cumTotal: 25560, target: 45, curve: 1.12 };
    const swiftTable = tables.swiftCumTotal || { cumTotal: 25560, target: 45, curve: 1.12 };
    const cumStrong = Array.isArray(tables.strongCumWan) && tables.strongCumWan.length
      ? tables.strongCumWan : buildCumGeo(strongTable.cumTotal, strongTable.target, strongTable.curve);
    const cumSwift = Array.isArray(tables.swiftCumWan) && tables.swiftCumWan.length
      ? tables.swiftCumWan : buildCumGeo(swiftTable.cumTotal, swiftTable.target, swiftTable.curve);
    const extras = [
      { key: 'qiangZhuang', name: '强壮', cum: cumStrong },
      { key: 'shenSu', name: '神速', cum: cumSwift },
    ];
    for (const e of extras) {
      const cur = character[e.key];
      if (cur === undefined || cur === null || cur === '') {
        items.push({ category: '底子', name: e.name, method: '成本折算', basis: '-', discount: disc.strong, value: 0, status: 'missing' });
        continue;
      }
      const interval = intervalCost(e.cum, cur);
      items.push({
        category: '底子', name: e.name, method: '成本折算',
        basis: `${cur}级，累计消耗 ${fmt(interval)} 万两`,
        discount: disc.strong, value: fmt(interval * rate * disc.strong), status: 'ok',
      });
    }

    // ---- 6. 潜能果 / 化圣 ----
    const pf = character.potentialFruitCount;
    if (pf !== undefined && pf !== null && pf !== '' && params.potentialFruitUnit > 0) {
      items.push({ category: '底子', name: '潜能果', method: '数量×单价', basis: `${pf}个 × ${params.potentialFruitUnit}元`, discount: '-', value: fmt(pf * params.potentialFruitUnit), status: 'ok' });
    }
    const hs = character.huaShengLayers;
    if (hs !== undefined && hs !== null && hs !== '' && params.huaShengUnit > 0) {
      items.push({ category: '底子', name: '化圣层数', method: '数量×单价', basis: `${hs}层 × ${params.huaShengUnit}元`, discount: '-', value: fmt(hs * params.huaShengUnit), status: 'ok' });
    }

    // ---- 7. 经验底子 ----
    const expYi = character.totalExpYi;
    if (expYi !== undefined && expYi !== null && expYi !== '') {
      const eb = params.expBonus;
      let bonus = 0;
      let basis = `${expYi}亿`;
      if (expYi > eb.threshold2) {
        bonus = eb.stack ? eb.bonus1 + eb.bonus2 : Math.max(eb.bonus1, eb.bonus2);
        basis += `（>${eb.threshold2}亿）`;
      } else if (expYi > eb.threshold1) {
        bonus = eb.bonus1;
        basis += `（>${eb.threshold1}亿）`;
      }
      if (bonus > 0) items.push({ category: '底子', name: '经验加成', method: '固定金额', basis, discount: '-', value: fmt(bonus), status: 'ok' });
    }

    // ---- 8. 坐骑 ----
    const mounts = Array.isArray(character.mounts) ? character.mounts : [];
    const mb = params.mountBonus;
    let mountCount = 0;
    let mountBonus = 0;
    mounts.forEach((m) => {
      const g = Number(m.growth);
      if (!isFinite(g)) return;
      let b = 0;
      if (g > mb.t2) b = mb.b2;
      else if (g > mb.t1) b = mb.b1;
      if (b > 0) { mountCount++; mountBonus += b; }
    });
    if (mountCount > 0) {
      items.push({ category: '底子', name: '坐骑加成', method: '固定金额', basis: `${mountCount}只命中（>${mb.t2} 加${mb.b2} / >${mb.t1} 加${mb.b1}）`, discount: '-', value: fmt(mountBonus), status: 'ok' });
    }

    // ---- 9. 神器 ----
    const sq = character.shenQiPoints;
    if (sq !== undefined && sq !== null && sq !== '') {
      const sqc = params.shenQi;
      let v = 0;
      let basis = `${sq}积分，未达合格线（${sqc.qualifiedPoints}）`;
      if (sq >= sqc.extremePoints) { v = sqc.extremePrice; basis = `${sq}积分，极限档`; }
      else if (sq >= sqc.qualifiedPoints) { v = sqc.qualifiedPrice; basis = `${sq}积分，合格档`; }
      items.push({ category: '底子', name: '神器', method: '固定金额', basis, discount: '-', value: fmt(v), status: 'ok' });
    }

    // ---- 10. 机缘 ----
    const jy = character.jiYuan;
    if (jy !== undefined && jy !== null && jy !== '') {
      const jc = params.jiYuan;
      const v = jy >= jc.full ? jc.fullBonus : Math.max(0, jc.fullBonus - (jc.full - jy) * jc.perPoint);
      items.push({ category: '底子', name: '机缘', method: '固定金额', basis: `${jy}点（满${jc.full}），每少1点扣${jc.perPoint}`, discount: '-', value: fmt(v), status: 'ok' });
    }

    // ---- 11. 装备 / 灵饰（档位金额）----
    const tc = character.tierCounts || {};
    const equipRules = tiers.equipment || [];
    const equipCount = {};
    if (tc.equip) {
      Object.keys(tc.equip).forEach((k) => {
        const n = Number(tc.equip[k]) || 0;
        if (n > 0) equipCount[k] = n;
      });
    } else {
      (character.equipments || []).forEach((e) => {
        const tier = classifyByKeywords(e.name, equipRules) || '未分档';
        equipCount[tier] = (equipCount[tier] || 0) + 1;
      });
    }
    for (const rule of equipRules) {
      const n = equipCount[rule.tier] || 0;
      if (n === 0) continue;
      items.push({ category: '装备', name: `${rule.tier}级装备`, method: '数量×单价', basis: `${n}件 × ${rule.price}元`, discount: '-', value: fmt(n * rule.price), status: 'ok' });
      delete equipCount[rule.tier];
    }
    if (equipCount['未分档']) {
      items.push({ category: '装备', name: '未分档装备', method: '数量×单价', basis: `${equipCount['未分档']}件 × 0元（请手动分档）`, discount: '-', value: 0, status: 'unclassified' });
    }

    const lingRules = tiers.lingshi || [];
    const lingCount = {};
    if (tc.lingshi) {
      Object.keys(tc.lingshi).forEach((k) => {
        const n = Number(tc.lingshi[k]) || 0;
        if (n > 0) lingCount[k] = n;
      });
    } else {
      (character.lingshi || []).forEach((e) => {
        const tier = classifyByKeywords(e.name, lingRules) || '未分档';
        lingCount[tier] = (lingCount[tier] || 0) + 1;
      });
    }
    for (const rule of lingRules) {
      const n = lingCount[rule.tier] || 0;
      if (n === 0) continue;
      items.push({ category: '灵饰', name: `${rule.tier}级灵饰`, method: '数量×单价', basis: `${n}件 × ${rule.price}元`, discount: '-', value: fmt(n * rule.price), status: 'ok' });
      delete lingCount[rule.tier];
    }
    if (lingCount['未分档']) {
      items.push({ category: '灵饰', name: '未分档灵饰', method: '数量×单价', basis: `${lingCount['未分档']}件 × 0元（请手动分档）`, discount: '-', value: 0, status: 'unclassified' });
    }

    // ---- 12. 召唤兽 / 孩子（档位金额）----
    const petCount = {};
    if (tc.pet) {
      Object.keys(tc.pet).forEach((k) => {
        const n = Number(tc.pet[k]) || 0;
        if (n > 0) petCount[k] = n;
      });
    } else {
      (character.pets || []).forEach((p) => {
        const tier = classifyPet(p, tiers) || 'C';
        petCount[tier] = (petCount[tier] || 0) + 1;
      });
    }
    for (const rule of tiers.petTiers || []) {
      const n = petCount[rule.tier] || 0;
      if (n === 0) continue;
      items.push({ category: '宝宝', name: `${rule.tier}级召唤兽`, method: '数量×单价', basis: `${n}只 × ${rule.price}元`, discount: '-', value: fmt(n * rule.price), status: 'ok' });
      delete petCount[rule.tier];
    }
    const childCount = {};
    if (tc.child) {
      Object.keys(tc.child).forEach((k) => {
        const n = Number(tc.child[k]) || 0;
        if (n > 0) childCount[k] = n;
      });
    } else {
      (character.children || []).forEach((c) => {
        const tier = classifyChild(c, tiers) || 'C';
        childCount[tier] = (childCount[tier] || 0) + 1;
      });
    }
    for (const rule of tiers.childTiers || []) {
      const n = childCount[rule.tier] || 0;
      if (n === 0) continue;
      items.push({ category: '孩子', name: `${rule.tier}级孩子`, method: '数量×单价', basis: `${n}个 × ${rule.price}元`, discount: '-', value: fmt(n * rule.price), status: 'ok' });
      delete childCount[rule.tier];
    }

    // ---- 13. 外观溢价 ----
    const ap = Number(params.appearanceBonus) || 0;
    if (ap > 0) {
      items.push({ category: '外观', name: '全局外观溢价', method: '手动输入', basis: '全局加价', discount: '-', value: fmt(ap), status: 'ok' });
    }

    // ---- 汇总 ----
    let total = 0;
    const groups = { cost: 0, tier: 0, fixed: 0, appearance: 0 };
    const costCats = ['人修', '宠修', '技能', '乾元丹', '底子'];
    for (const it of items) {
      total += it.value;
      if (it.category === '外观') groups.appearance += it.value;
      else if (it.method === '数量×单价') groups.tier += it.value;
      else if (costCats.includes(it.category)) groups.cost += it.value;
      else groups.fixed += it.value;
    }
    const missing = items.filter((i) => i.status === 'missing').map((i) => i.name);
    const unclassified = items.filter((i) => i.status === 'unclassified').map((i) => i.name);
    return {
      items,
      total: fmt(total),
      groups: {
        cost: fmt(groups.cost), tier: fmt(groups.tier),
        fixed: fmt(groups.fixed), appearance: fmt(groups.appearance),
      },
      missing,
      unclassified,
    };
  }

  return { estimate, buildCumGeo, intervalCost, skillIntervalCost, classifyByKeyword: classifyByKeywords };
});
