/** 浏览器内生成 Excel（双 Sheet）：估值明细 + 录入快照 */
(function (root) {
  const MHY = root.MHY || (root.MHY = {});

  const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

  async function buildWorkbook(character, params, result, meta) {
    const ExcelJS = root.ExcelJS;
    if (!ExcelJS) throw new Error('Excel 组件未加载，请刷新页面重试');
    const wb = new ExcelJS.Workbook();
    wb.creator = '梦幻西游藏宝阁账号估值助手';
    wb.created = new Date();

    const ws = wb.addWorksheet('估值明细表');
    ws.columns = [
      { header: '大类', key: 'category', width: 12 },
      { header: '项目', key: 'name', width: 22 },
      { header: '计价方式', key: 'method', width: 14 },
      { header: '计算依据', key: 'basis', width: 40 },
      { header: '折现比例', key: 'discount', width: 11 },
      { header: '估值小计(元)', key: 'value', width: 15 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEAF7' } };

    result.items.forEach((it) => {
      const row = ws.addRow({
        category: it.category,
        name: it.name,
        method: it.method,
        basis: it.basis,
        discount: it.discount,
        value: money(it.value),
      });
      row.getCell('value').numFmt = '#,##0.00';
      if (it.status === 'missing') row.font = { color: { argb: 'FFB4531A' } };
    });

    const sumRow = ws.addRow({
      category: '合计', name: '', method: '', basis: '',
      discount: '', value: money(result.total),
    });
    sumRow.font = { bold: true };
    sumRow.getCell('value').numFmt = '#,##0.00';
    ws.addRow([]);
    const g = result.groups;
    ws.addRow(['分组小计', '成本折算', `¥${money(g.cost)}`, '档位金额', `¥${money(g.tier)}`, `外观 ¥${money(g.appearance)}`]).font = { bold: true };

    const ws2 = wb.addWorksheet('录入快照');
    ws2.columns = [
      { header: '字段', key: 'k', width: 24 },
      { header: '值', key: 'v', width: 46 },
    ];
    ws2.getRow(1).font = { bold: true };
    ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEAF7' } };

    const push = (k, v) => ws2.addRow({ k, v: v === undefined || v === '' ? '—' : String(v) });
    push('导出时间', new Date().toLocaleString('zh-CN'));
    push('等级', character.level);
    push('门派', character.sect);
    push('总经验（亿）', character.totalExpYi);
    push('化圣层数', character.huaShengLayers);
    push('机缘', character.jiYuan);
    push('乾元丹', character.qianYuanDan);
    push('潜能果', character.potentialFruitCount);
    push('神器积分', character.shenQiPoints);
    push('人物修炼', ['攻', '防', '法', '抗'].map((n, i) => {
      const k = ['gong', 'fang', 'fa', 'kang'][i];
      return `${n}${character.renXiu && character.renXiu[k] !== undefined ? character.renXiu[k] : '—'}`;
    }).join(' / '));
    push('召唤兽修炼', ['攻', '防', '法', '抗'].map((n, i) => {
      const k = ['gong', 'fang', 'fa', 'kang'][i];
      return `${n}${character.chongXiu && character.chongXiu[k] !== undefined ? character.chongXiu[k] : '—'}`;
    }).join(' / '));
    push('师门技能', (character.skills || []).map((v) => (v === '' || v === undefined ? '—' : v)).join(' / '));
    push('强壮 / 神速', `${character.qiangZhuang ?? '—'} / ${character.shenSu ?? '—'}`);
    push('坐骑成长', (character.mounts || []).map((m) => m.growth).filter((v) => v !== '' && v !== undefined).join(' / ') || '—');
    push('金价（元/万两）', params.goldRate);
    push('折现比例', `人修 ${params.discounts.renXiu} / 宠修 ${params.discounts.chongXiu} / 技能 ${params.discounts.skill} / 乾元丹 ${params.discounts.qianYuanDan} / 强壮神速 ${params.discounts.strong}`);
    push('档位计数', JSON.stringify((meta && meta.counts) || {}, null, 0));
    push('缺失项', (result.missing || []).join('、') || '无');

    return wb;
  }

  async function download(character, params, result, meta) {
    const wb = await buildWorkbook(character, params, result, meta);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `藏宝阁估值-${(character.sect || '账号')}-${character.level || ''}-${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  MHY.exportXlsx = { download, buildWorkbook };
})(typeof self !== 'undefined' ? self : this);
