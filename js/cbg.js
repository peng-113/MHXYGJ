/**
 * 藏宝阁数据解码与字段映射（纯浏览器，无需服务器）
 * 链路：@盐@base64 -> JSON{d} -> 逐字符 XOR 盐 -> LPC 字符串 -> JS 对象 -> 统一 character 结构
 * 说明：页面里的 RoleInfoParser 负责拆分技能/装备/宝宝；纯静态页拿不到它，
 *       但 raw 数据中已包含等级、人修、宠修、乾元丹、机缘、神器积分、潜能果、总经验等核心字段。
 */
(function (root) {
  const MHY = root.MHY || (root.MHY = {});

  /** 去掉描述里的颜色控制符（#G #Y #r #n 以及 #cFF6F28 这类六位色号） */
  function stripColor(s) {
    return String(s || '')
      .replace(/#c[0-9a-fA-F]{6}/g, ' ')
      .replace(/#[RGBK_YWbunr]/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 房屋等级（藏宝阁 rent_level） */
  const HOUSE_LEVELS = {
    0: '无', 1: '普通', 2: '华宅', 3: '豪宅',
    4: '华宅(带阁楼)', 5: '豪宅(带阁楼)', 6: '金屋玉宅', 7: '洞天福地',
  };
  /** 已知风水，按优先级从好到差 */
  const HOUSE_FENG_SHUI = ['紫气东来', '福气东来', '富贵逼人', '平步青云'];

  /**
   * 解析居住房屋：raw.rent_level 给等级，raw.house_fangqi[0].desc 形如
   * "58736508号豪宅 规格22231 紫气东来 庭园规模大型"，从中再取风水。
   * 返回 { type, fengShui, desc } 或 null
   */
  function parseHouse(raw) {
    const src = raw || {};
    const out = { type: '', fengShui: '', desc: '' };
    const list = Array.isArray(src.house_fangqi) ? src.house_fangqi : [];
    const first = list.find((x) => x && (x.desc || x.name));
    const desc = first ? String(first.desc || first.name) : '';
    const level = Number(src.rent_level);
    // rent_level 明确为 0 就是"无房屋"：此时不该有等级也不该有风水，
    // 直接返回，避免旧数据/描述里残留的词被误读成风水
    if (level === 0) return { type: '无', fengShui: '', desc: '' };
    if (isFinite(level) && HOUSE_LEVELS[level] !== undefined) out.type = HOUSE_LEVELS[level];
    if (desc) {
      out.desc = desc;
      const t = desc.match(/号\s*(普通|华宅|豪宅|金屋玉宅|洞天福地|带阁楼)/);
      if (t) out.type = t[1];
      else if (!out.type) {
        if (desc.includes('金屋玉宅')) out.type = '金屋玉宅';
        else if (desc.includes('豪宅')) out.type = '豪宅';
        else if (desc.includes('华宅')) out.type = '华宅';
      }
      const known = HOUSE_FENG_SHUI.find((k) => desc.includes(k));
      if (known) out.fengShui = known;
      else {
        // 兜底：去掉 “xxxx号…”“规格…”“庭园规模…” 后剩下的那个词就是风水
        const parts = desc.split(/\s+/).filter(Boolean);
        const feng = parts.find((p) => !/号/.test(p) && !/^规格/.test(p) && !/^庭/.test(p));
        if (feng) out.fengShui = feng;
      }
    }
    if (!out.type && !out.desc) return null;
    return out;
  }

  /** 仓颉神木（法宝 iType=6116）的修炼境界，raw.fabao 里形如 “修炼境界：第#G28#Y层” */
  function parseCangJie(fabao) {
    if (!fabao || typeof fabao !== 'object') return undefined;
    const list = Object.keys(fabao).map((k) => fabao[k]).filter((f) => f && typeof f === 'object');
    const hit = list.find((f) => Number(f.iType) === 6116 || Number(f.type) === 6116);
    if (!hit) return undefined;
    const desc = stripColor(hit.cDesc || hit.desc || '');
    const m = desc.match(/修炼境界[：:]\s*第?\s*(\d+)\s*层/);
    return m ? Number(m[1]) : undefined;
  }

  /**
   * 从整页源码 / 文本里读售价：优先页面内嵌数据 "price" : '16999.00'（本商品，
   * 推荐位是整数价格且在其后），其次取显式的“售价：xxx”。
   */
  function parsePriceFromText(text) {
    const s = String(text || '');
    const explicit = s.match(/售价[：:]\s*[￥¥]?\s*([\d,]+(?:\.\d+)?)/);
    if (explicit) return Number(explicit[1].replace(/,/g, ''));
    const data = s.match(/"price"\s*:\s*['"]?\s*(\d+(?:\.\d+)?)/)
      || s.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/);
    if (data) return Number(data[1]);
    return undefined;
  }

  function countSkills(entry) {
    const sk = entry.all_skills || entry.skills || entry.skill;
    if (!sk) return undefined;
    if (Array.isArray(sk)) return sk.length;
    if (typeof sk === 'object') return Object.keys(sk).length;
    return undefined;
  }

  const b64ToText = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  };

  /** 解密 desc：@盐@base64 -> LPC 文本 */
  function decodeDesc(desc) {
    const parts = String(desc).split('@');
    if (parts.length < 3) throw new Error('密文格式异常（缺少 @盐@ 段）');
    const salt = parts[1];
    const obj = JSON.parse(b64ToText(parts[2].replace(/\s+/g, '')));
    if (!obj || typeof obj.d !== 'string') throw new Error('密文解码后缺少 d 字段');
    let out = '';
    for (let i = 0; i < obj.d.length; i++) {
      out += String.fromCharCode(obj.d.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
    }
    return out;
  }

  /** LPC 文本 -> JS 表达式文本（数字键、([ ]) 映射等问题在此处理） */
  function lpcToJs(lpc) {
    const dict = { '([': '{', '])': '}', '({': '[', '})': ']', ',})': ']', ',])': '}' };
    return String(lpc).replace(/\(\[|,?\s*\]\)|\(\{|,?\s*\}\)/g, (m) => dict[m.replace(/\s+/g, '')] || m);
  }

  /** LPC 文本 -> JS 对象 */
  function lpcToObject(lpc) {
    return new Function('return (' + lpcToJs(lpc) + ')')();
  }

  /** 从整页 HTML / 密文中取出密文串（真实密文可能以 @ 结尾，需容错） */
  function extractDesc(text) {
    const s = String(text || '').trim();
    const trimAt = (v) => String(v || '').replace(/@+\s*$/, '').trim();
    // 纯密文：@盐@base64（允许结尾多一个 @、允许中间含空白）
    const bare = trimAt(s);
    if (/^@[^@\s]+@[A-Za-z0-9+/=\s]+$/.test(bare)) return bare.replace(/\s+/g, '');
    const patterns = [
      /id=["']equip_desc_value["'][^>]*>([\s\S]*?)<\/textarea>/i,
      /id=["']equip_desc_value["'][^>]*value=["']([^"']+)["']/i,
      /"equip_desc_value"\s*:\s*"([^"]+)"/i,
      /"equip_desc"\s*:\s*"(@[^"]+)"/i,
      /value=["'](@[^"']{40,})["']/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m && m[1]) {
        return trimAt(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      }
    }
    // 兜底：整段文本里夹着别的文字时（如书签附加的“月饼粽子机缘：40/69”），直接抓子串
    const loose = s.match(/@[^@\s]{1,40}@[A-Za-z0-9+/=]{40,}@?/);
    if (loose) return trimAt(loose[0]);
    return null;
  }

  /** 从原始 raw 数据中尽力搜集可映射字段（raw 结构随版本略有差异） */
  function normalizeRaw(obj) {
    const raw = {};
    const src = obj && typeof obj === 'object' ? obj : {};
    const get = (k) => (src[k] !== undefined ? src[k] : (src.raw && src.raw[k]));
    [
      'iGrade', 'cName', 'iSchool', 'sum_exp', 'i3FlyLv', 'iZhuanZhi',
      'jiyuan', 'ji_yuan',
      'iExptSki1', 'iExptSki2', 'iExptSki3', 'iExptSki4', 'iExptSki5',
      'iBeastSki1', 'iBeastSki2', 'iBeastSki3', 'iBeastSki4',
      'iNutsNum', 'addPoint', 'TA_iAllNewPoint', 'TA_iAllPoint', 'shenqi_score',
      'all_skills', 'AllEquip',
      'total_avatar', 'total_horse', 'normal_horse', 'perform_effect',
      'rent_level', 'outdoor_level', 'house_fangqi', 'fabao',
    ].forEach((k) => {
      const v = get(k);
      if (v !== undefined && v !== null) raw[k] = v;
    });
    return raw;
  }

  /**
   * 从 raw.all_skills（技能ID -> 等级 的扁平字典）拆出：
   *   - 7 个师门技能（按 pos 1-7 归位）
   *   - 强壮（230）/ 神速（237）/ 猎术（221）
   * 页面里的 RoleInfoParser 也是读这个字段，只是额外做了名称/图标查找。
   */
  function parseSkillsFromRaw(raw) {
    const all = raw && (raw.all_skills || raw.allSkills);
    if (!all || typeof all !== 'object') return null;
    const map = root.MHY_SKILL_MAP || {};
    const posMap = map.school || {};
    const nameMap = map.names || {};
    const life = map.life || {};
    const byPos = {};
    Object.keys(all).forEach((id) => {
      const grade = Number(all[id]);
      if (!isFinite(grade)) return;
      const pos = posMap[id];
      if (pos >= 1 && pos <= 7 && byPos[pos] === undefined) {
        byPos[pos] = { grade, name: nameMap[id] || '' };
      }
    });
    const found = Object.keys(byPos).length;
    if (!found) return null;
    const skills = [];
    const skillNames = [];
    for (let p = 1; p <= 7; p++) {
      skills.push(byPos[p] ? byPos[p].grade : '');
      skillNames.push(byPos[p] ? byPos[p].name : '');
    }
    const lifeGrade = (id) => (id && all[id] !== undefined && isFinite(Number(all[id])) ? Number(all[id]) : undefined);
    return {
      skills,
      skillNames,
      qiangZhuang: lifeGrade(life.qiangZhuang),
      shenSu: lifeGrade(life.shenSu),
      // 育兽术（221）仅展示，不参与计价；猎术是人物修炼第 5 项，不在这里
      yuShouShu: lifeGrade(life.yuShouShu),
      complete: found >= 7,
    };
  }

  /** 计数类字段：读不到就按 0 处理（导入时才能正确覆盖上一次的旧值） */
  function orZero(v) {
    return v === undefined || v === null || v === '' || !isFinite(Number(v)) ? 0 : Number(v);
  }

  /** 把 raw 映射为统一 character（只填能确定的字段） */
  function mapRaw(raw, extra) {
    const ch = {};
    const num = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const m = v.match(/([\d.]+)/);
        if (m) return parseFloat(m[1]);
      }
      return undefined;
    };
    const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);

    ch.level = num(pick(raw.iGrade, undefined));
    // sum_exp 为绝对经验值，换算为"亿"；若已是亿级小数字则原样保留
    const expRaw = num(pick(raw.sum_exp, undefined));
    ch.totalExpYi = expRaw === undefined ? undefined
      : (expRaw > 1e6 ? Math.round((expRaw / 1e8) * 10) / 10 : expRaw);
    ch.huaShengLayers = num(pick(raw.i3FlyLv, 0));
    // 机缘：藏宝阁"月饼粽子机缘"= addPoint(月饼粽子食用量) + jiyuan(已获得机缘属性)
    // 页面模板原逻辑：basic_info.add_point + basic_info.ji_yuan
    const jiEat = num(raw.addPoint);
    const jiBase = num(raw.jiyuan);
    if (jiEat !== undefined || jiBase !== undefined) {
      ch.jiYuan = (jiEat || 0) + (jiBase || 0);
      if (jiEat !== undefined) ch.jiYuanEat = jiEat;
      if (jiBase !== undefined) ch.jiYuanBase = jiBase;
    }
    ch.qianYuanDan = num(pick(raw.TA_iAllNewPoint, raw.TA_iAllPoint));
    // 潜能果：raw 字段名是 iNutsNum
    ch.potentialFruitCount = num(pick(raw.iNutsNum, raw.qian_neng_guo));
    // 神器积分：已取消计价，保留解析结果仅供展示（不再参与估值）
    ch.shenQiPoints = num(pick(raw.shenqi_score, undefined));

    // ---- 外观：锦衣 / 祥瑞 / 施法攻击特效 ----
    // 注意：这几项（以及下面的房屋/仓颉神木）即使本账号没有，也必须显式赋 0/空，
    // 否则导入时不会覆盖上一账号的值，界面上就会出现"上一账号的残留数据"。
    ch.jinYiCount = orZero(num(raw.total_avatar));
    ch.xiangRuiCount = orZero(num(pick(
      raw.total_horse,
      raw.HugeHorse && typeof raw.HugeHorse === 'object'
        ? (Array.isArray(raw.HugeHorse) ? raw.HugeHorse.length : Object.keys(raw.HugeHorse).length)
        : undefined,
    )));
    let txCount;
    if (Array.isArray(raw.perform_effect)) txCount = raw.perform_effect.length;
    else if (raw.perform_effect && typeof raw.perform_effect === 'object') txCount = Object.keys(raw.perform_effect).length;
    ch.teXiaoCount = orZero(txCount);

    // ---- 家园 / 仓颉神木 ----
    // 房屋为"无"时风水必须清空（此前只写有值的字段，风水会残留上一次的）
    const house = parseHouse(raw) || { type: '', fengShui: '', desc: '' };
    ch.houseType = house.type || '';
    ch.houseFengShui = house.fengShui || '';
    ch.houseDesc = house.desc || '';
    // 没有仓颉神木（法宝里找不到 iType=6116）时为 0 层，而不是沿用上次读到的层数
    ch.cangJieLevel = orZero(parseCangJie(raw.fabao));

    if (raw.cName) ch.nickname = String(raw.cName);
    // 门派：iSchool 是门派ID，用 school_info 映射成名称
    const schoolMap = ((root.MHY_SKILL_MAP || {}).schools) || {};
    if (raw.iSchool !== undefined && schoolMap[String(raw.iSchool)]) {
      ch.sect = schoolMap[String(raw.iSchool)];
    }

    ch.renXiu = {
      gong: num(raw.iExptSki1), fang: num(raw.iExptSki2),
      fa: num(raw.iExptSki3), kang: num(raw.iExptSki4),
    };
    ch.shouShu = num(raw.iExptSki5);
    ch.chongXiu = {
      gong: num(raw.iBeastSki1), fang: num(raw.iBeastSki2),
      fa: num(raw.iBeastSki3), kang: num(raw.iBeastSki4),
    };

    // 师门技能 / 强壮 / 神速 / 育兽术：来自 raw.all_skills（离线可解析）
    const sk = parseSkillsFromRaw(raw);
    if (sk) {
      ch.skills = sk.skills;
      ch.skillNames = sk.skillNames;
      if (sk.qiangZhuang !== undefined) ch.qiangZhuang = sk.qiangZhuang;
      if (sk.shenSu !== undefined) ch.shenSu = sk.shenSu;
      if (sk.yuShouShu !== undefined) ch.yuShouShu = sk.yuShouShu;
    }
    Object.keys(ch.renXiu).forEach((k) => { if (ch.renXiu[k] === undefined) delete ch.renXiu[k]; });
    Object.keys(ch.chongXiu).forEach((k) => { if (ch.chongXiu[k] === undefined) delete ch.chongXiu[k]; });
    if (extra && extra.sect) ch.sect = extra.sect;
    return ch;
  }

  /**
   * 从整页源码里读"月饼粽子机缘：40/69"（服务端渲染，源码里就有）
   * 返回 { value, cap } 或 null
   */
  function parseJiYuanFromHtml(text) {
    // 真实源码形如：<strong>月饼粽子机缘：</strong>40/69，需先去掉标签
    const plain = String(text || '').replace(/<[^>]*>/g, '');
    const m = plain.match(/月饼粽子机缘[：:]\s*(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { value: Number(m[1]), cap: Number(m[2]) };
  }

  /** 完整导入：文本（页面源码或密文） -> { character, warnings, raw } */
  function importFromText(text) {
    const desc = extractDesc(text);
    if (!desc) {
      throw new Error('没找到装备描述密文。请复制详情页"查看源码"全文，或直接粘贴以 @ 开头的密文串。');
    }
    const lpc = decodeDesc(desc);
    const obj = lpcToObject(lpc);
    const raw = normalizeRaw(obj);
    const ch = mapRaw(raw);
    // 页面源码里的"月饼粽子机缘：X/Y"更权威（含上限），优先采用
    const jy = parseJiYuanFromHtml(text);
    if (jy) {
      ch.jiYuan = jy.value;
      if (jy.cap) ch.jiYuanCap = jy.cap;
    }
    // 售价：页面内嵌数据 / 书签带的“售价：xxx”
    const price = parsePriceFromText(text);
    if (price !== undefined) ch.salePrice = price;
    const filled = [];
    if (ch.level) filled.push('等级');
    if (ch.sect) filled.push('门派');
    if (ch.renXiu && Object.keys(ch.renXiu).length) filled.push('人物修炼');
    if (ch.chongXiu && Object.keys(ch.chongXiu).length) filled.push('召唤兽修炼');
    if (ch.qianYuanDan !== undefined) filled.push('乾元丹');
    if (ch.jiYuan !== undefined) filled.push(`机缘 ${ch.jiYuan}${ch.jiYuanCap ? '/' + ch.jiYuanCap : ''}`);
    if (ch.potentialFruitCount !== undefined) filled.push('潜能果');
    if (ch.totalExpYi !== undefined) filled.push('总经验');
    if (ch.huaShengLayers !== undefined) filled.push('化圣层数');
    if (ch.jinYiCount !== undefined) filled.push(`锦衣 ${ch.jinYiCount}`);
    if (ch.xiangRuiCount !== undefined) filled.push(`祥瑞 ${ch.xiangRuiCount}`);
    if (ch.teXiaoCount !== undefined) filled.push(`特效 ${ch.teXiaoCount}`);
    if (ch.cangJieLevel > 0) filled.push(`仓颉神木 ${ch.cangJieLevel}层`);
    if (ch.houseType) filled.push(`房屋 ${ch.houseType}${ch.houseFengShui ? '·' + ch.houseFengShui : ''}`);
    if (ch.salePrice !== undefined) filled.push(`售价 ${ch.salePrice}元`);
    const skillFilled = Array.isArray(ch.skills) && ch.skills.filter((v) => v !== '' && v !== undefined).length;
    if (skillFilled) filled.push(`师门技能 ${skillFilled} 项`);
    if (ch.qiangZhuang !== undefined) filled.push('强壮');
    if (ch.shenSu !== undefined) filled.push('神速');
    if (ch.yuShouShu !== undefined) filled.push('育兽术');
    if (ch.shouShu !== undefined) filled.push('猎术');
    const warnings = [];
    if (!skillFilled) warnings.push('未找到师门技能数据，请手动填写');
    if (ch.qiangZhuang === undefined) warnings.push('未找到强壮等级，请手动填写');
    if (ch.shenSu === undefined) warnings.push('未找到神速等级，请手动填写');
    if (ch.jiYuan !== undefined && !(Number(ch.jiYuanCap) > 0)) warnings.push('未读到机缘上限（只贴密文时无此数据），机缘按参数页的“满点”计算；粘贴整页源码可自动带上限');
    if (!ch.houseType) warnings.push('未读到居住房屋信息，可手动填写');
    if (ch.salePrice === undefined) warnings.push('未读到售价，可在基础页手动填写');
    warnings.push('装备 / 灵饰 / 召唤兽档位需在“装备宝宝”页手动计数');
    return { character: ch, warnings, filled, raw };
  }

  /** 把页面 RoleInfoParser 的输出映射为统一 character（保留完整版能力，供未来接入） */
  function mapCbgData(d) {    const ch = {};
    const raw = d.raw || {};
    const basic = d.basic_info || {};
    const num = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const m = v.match(/([\d.]+)/);
        if (m) return parseFloat(m[1]);
      }
      return undefined;
    };
    ch.level = raw.iGrade !== undefined ? raw.iGrade : basic.role_level;
    ch.sect = basic.school || '';
    ch.nickname = basic.nickname || raw.cName || '';
    ch.totalExpYi = num(raw.sum_exp !== undefined ? raw.sum_exp : basic.sum_exp);
    ch.huaShengLayers = raw.i3FlyLv !== undefined ? raw.i3FlyLv : 0;
    ch.jiYuan = raw.jiyuan !== undefined ? raw.jiyuan : (raw.ji_yuan !== undefined ? raw.ji_yuan : basic.ji_yuan);
    ch.qianYuanDan = raw.TA_iAllNewPoint !== undefined ? raw.TA_iAllNewPoint
      : (basic.qian_yuan_dan && basic.qian_yuan_dan.new_value !== undefined ? basic.qian_yuan_dan.new_value : undefined);
    ch.potentialFruitCount = raw.qian_neng_guo !== undefined ? raw.qian_neng_guo : (basic.qian_neng_guo !== undefined ? num(basic.qian_neng_guo) : undefined);
    ch.shenQiPoints = raw.shenqi_score !== undefined ? raw.shenqi_score : basic.shenqi_score;
    ch.renXiu = { gong: raw.iExptSki1, fang: raw.iExptSki2, fa: raw.iExptSki3, kang: raw.iExptSki4 };
    ch.shouShu = raw.iExptSki5;
    ch.chongXiu = { gong: raw.iBeastSki1, fang: raw.iBeastSki2, fa: raw.iBeastSki3, kang: raw.iBeastSki4 };

    const schoolSkills = ((d.role_skill || {}).school_skill || [])
      .slice().sort((a, b) => (a.skill_pos || 0) - (b.skill_pos || 0));
    ch.skills = schoolSkills.slice(0, 7).map((s) => s.skill_grade);
    ch.skillNames = schoolSkills.slice(0, 7).map((s) => s.name || s.skill_name || '');

    const life = (d.role_skill || {}).life_skill || [];
    const findLife = (kw) => {
      const hit = life.find((s) => String(s.name || '').includes(kw));
      return hit ? hit.skill_grade : undefined;
    };
    ch.qiangZhuang = findLife('强壮');
    ch.shenSu = findLife('神速');

    const allEq = [...(d.using_equips || []), ...(d.not_using_equips || [])];
    const eqName = (e) => stripColor(e.desc).slice(0, 80) || stripColor(e.name) || '装备';
    ch.equipments = allEq.filter((e) => e.pos >= 1 && e.pos <= 6).map((e) => ({ name: eqName(e), tags: [] }));
    ch.lingshi = allEq.filter((e) => e.pos >= 187 && e.pos <= 191).map((e) => ({ name: eqName(e), tags: [] }));
    const others = allEq.filter((e) => !(e.pos >= 1 && e.pos <= 6) && !(e.pos >= 187 && e.pos <= 191));
    ch.equipments = ch.equipments.concat(others.slice(0, 20).map((e) => ({ name: eqName(e), tags: [] })));

    ch.pets = (Array.isArray(d.pet_info) ? d.pet_info : []).filter((e) => e && typeof e === 'object').map((e) => {
      const sc = countSkills(e);
      return { name: stripColor(e.pet_name || e.name || '').slice(0, 40) || '召唤兽', skillCount: sc || 0, tags: [] };
    });
    ch.children = (Array.isArray(d.child_info) ? d.child_info : []).map((e) => ({
      name: stripColor(e.pet_name || e.name || '').slice(0, 40) || '孩子',
      skillCount: countSkills(e) || 0,
      tags: [],
    }));
    ch.mounts = (d.rider_info || []).map((r) => ({ growth: Number(r.exgrow || r.grow) || 0, name: r.type_name || '' }));

    const jinyiAll = [];
    for (const g of (d.new_clothes || [])) {
      for (const c of (g && Array.isArray(g.list) ? g.list : [])) {
        const n = stripColor(c.name || '').slice(0, 40);
        if (n && !jinyiAll.some((x) => x.name === n)) jinyiAll.push({ name: n, tags: [] });
      }
    }
    ch.jinyi = jinyiAll.length ? jinyiAll
      : (d.clothes || []).map((c) => ({ name: stripColor(c.cName || c.name || ''), tags: [] })).filter((x) => x.name);
    ch.xiangrui = (d.xiangrui || []).map((x) => ({ name: stripColor(x.cName || x.name || ''), tags: x.skill_name ? [x.skill_name] : [] }));
    ch.fabaos = (d.using_fabao || []).map((f) => stripColor(f.cName || f.name || f.desc).slice(0, 40)).filter(Boolean);
    return ch;
  }

  MHY.cbg = {
    decodeDesc, lpcToJs, lpcToObject, extractDesc, importFromText, mapCbgData, mapRaw,
    normalizeRaw, parseSkillsFromRaw, parseJiYuanFromHtml, stripColor,
    parseHouse, parseCangJie, parsePriceFromText,
  };
  if (typeof module === 'object' && module.exports) module.exports = MHY.cbg;
})(typeof self !== 'undefined' ? self : this);
