# 梦幻西游 · 藏宝阁账号估值助手（网页版）

纯静态网页，**无需服务器、无需安装**，手机 / 电脑浏览器打开即用。
估值算法与桌面版完全一致（官方逐级消耗表 + 成本折算 + 档位金额 + 固定金额）。

## 在线使用

部署到 GitHub Pages 后，直接访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

## 功能

- **七段录入**：基础 / 人修 / 宠修 / 技能 / 底子 / 装备宝宝 / 参数，留空按"缺失"提示
- **实时估值**：任意输入即时重算，底部常驻合计栏
- **页面导入**（电脑端）：粘贴藏宝阁详情页源码，浏览器内解密自动填入
  等级、人修、宠修、乾元丹、机缘、神器积分、潜能果、总经验、化圣层数
- **Excel 导出**：双 Sheet（估值明细 + 录入快照），浏览器内直接生成下载
- **参数可调**：金价、五项折现、档位价格、机缘/神器/坐骑/经验规则，全部本机保存
- **隐私**：所有数据只存在你的浏览器 localStorage，不上传任何服务器

## 本地开发

```bash
# 任意静态服务器即可，例如
python3 -m http.server 8320
# 打开 http://127.0.0.1:8320
```

验收测试（需父目录的 node_modules，含 Playwright）：

```bash
node ../scripts/test-web.js
```

## 部署到 GitHub Pages（一次性，约 3 分钟）

1. 在 GitHub 新建一个仓库（如 `mhy-valuator`，Public）；
2. 在本目录执行：

```bash
git init
git add .
git commit -m "藏宝阁账号估值助手 网页版"
git branch -M main
git remote add origin https://github.com/<你的用户名>/mhy-valuator.git
git push -u origin main
```

3. 仓库页面 → Settings → Pages → Source 选 `main` 分支 `/ (root)` → Save；
4. 等 1–2 分钟，访问 `https://<你的用户名>.github.io/mhy-valuator/`。

更新代码后只需 `git push`，页面自动更新。

## 目录结构

```
index.html          单页入口（七段标签 + 导入弹窗 + 底部合计）
css/style.css       移动优先样式，自动适配深色模式
js/config-data.js   默认参数与官方逐级消耗表（由桌面版 config 生成）
js/engine.js        估值引擎（与桌面版同源，Node/浏览器双用）
js/cbg.js           藏宝阁密文解码 + 字段映射（纯前端）
js/export.js        ExcelJS 生成双 Sheet 报表
js/app.js           状态管理与界面逻辑
vendor/exceljs.min.js  本地打包，无 CDN 依赖
```

## 与桌面版的关系

| | 桌面版（mhy-valuator） | 网页版（本目录） |
|---|---|---|
| 数据提取 | Playwright 浏览器自动抓全量 | 粘贴源码解密核心字段 + 手动补填 |
| 估值算法 | 同一套 | 同一套 |
| Excel 导出 | 双 Sheet | 双 Sheet |
| 使用条件 | 需安装 Node | 有浏览器即可 |
