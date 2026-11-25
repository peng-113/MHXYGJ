#!/bin/bash
# 一轮监控（CloudBase 云托管）：
#   公开仓库 peng-113/MHXYGJ   = 代码 + criteria/watch-list（网页端保存的监控列表）
#   私有仓库 peng-113/MHXYGJ-state = 会话凭证 + search-state.json（含敏感信息，不进公开仓库）
# 扫码自愈成功 → 新凭证写入私有仓库（下次运行直接可用）+ 更新 GitHub Secret（Actions 兜底通道）
set -u
cd /app/repo

export GIT_AUTHOR_NAME="cloudrun-bot" GIT_AUTHOR_EMAIL="cloudrun@tencent.com"
export GIT_COMMITTER_NAME="cloudrun-bot" GIT_COMMITTER_EMAIL="cloudrun@tencent.com"

# 1. 拉最新代码与配置（网页端保存的 watch-list 在公开仓库）
git pull --rebase -q || true

# 2. 私有状态仓库：克隆/更新，并把状态文件复制进工作目录
if [ ! -d /app/state/.git ] && [ -n "${GH_PAT:-}" ]; then
  git clone -q "https://x-access-token:${GH_PAT}@github.com/peng-113/MHXYGJ-state.git" /app/state || echo "⚠ state 仓库克隆失败"
fi
(cd /app/state && git pull --rebase -q || true)
[ -f /app/state/search-state.json ] && cp /app/state/search-state.json /app/repo/search-state.json

# 3. 运行一轮监控
node scripts/monitor.js
echo "monitor.js 退出码: $?"

# 4. 状态回写私有仓库（含扫码自愈新凭证 → 转成明文 session-state.json）
cp /app/repo/search-state.json /app/state/search-state.json 2>/dev/null || true
if [ -f /app/repo/new-session.b64 ]; then
  echo "检测到扫码自愈新凭证，写入私有状态仓库"
  cp /app/repo/new-session.b64 /app/state/session-state.b64
  base64 -d /app/repo/new-session.b64 > /app/state/session-state.json 2>/dev/null
fi
(cd /app/state \
  && git add -A \
  && { git diff --cached --quiet || git commit -q -m "状态更新(cloudrun) $(date +%m-%d-%H:%M)" && git push -q origin main; }) \
  || echo "⚠ state 回写失败"

# 5. 公开仓库回写（search-state.json 供网页端展示；无敏感信息）
git add search-state.json watch-list.json criteria.json 2>/dev/null || true
{ git diff --cached --quiet || git commit -q -m "监控状态更新(cloudrun) $(date +%m-%d-%H:%M)"; } \
  && [ -n "${GH_PAT:-}" ] && git push -q "https://peng-113:${GH_PAT}@github.com/peng-113/MHXYGJ.git" main:main \
  || echo "⚠ 公开仓库推送失败（冲突时下轮 rebase 处理）"

# 6. 扫码新凭证 → 更新 GitHub Secret（Actions 兜底通道）
if [ -f /app/repo/new-session.b64 ] && [ -n "${GH_PAT:-}" ]; then
  GH_PAT="$GH_PAT" python3 scripts/put-secret.py /app/repo/new-session.b64 && rm -f /app/repo/new-session.b64
fi
