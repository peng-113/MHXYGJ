#!/bin/bash
# 一轮监控：拉取最新代码 → 运行 monitor.js → 回写状态文件 → 扫码新凭证自动更新 Secret
set -u
cd /app/repo

export GIT_AUTHOR_NAME="cloudrun-bot" GIT_AUTHOR_EMAIL="cloudrun@tencent.com"
export GIT_COMMITTER_NAME="cloudrun-bot" GIT_COMMITTER_EMAIL="cloudrun@tencent.com"

git pull --rebase || true

node scripts/monitor.js
RC=$?
echo "monitor.js 退出码: $RC"

# 回写状态文件（云端可见，网页端也读取）
git add search-state.json watch-list.json criteria.json 2>/dev/null || true
git diff --cached --quiet || git commit -q -m "监控状态更新(cloudrun) $(date +%m-%d-%H:%M)"

# 推送回 GitHub（状态持久化 + 网页端展示）
if [ -n "${GH_PAT:-}" ]; then
  git push -q "https://peng-113:${GH_PAT}@github.com/peng-113/MHXYGJ.git" main:main || echo "推送失败（可能有冲突，下轮 rebase）"
else
  echo "未配置 GH_PAT，状态仅保留在本实例（会被缩容丢弃）"
fi

# 扫码自愈成功 → 立即更新 SESSION_STATE Secret
if [ -f new-session.b64 ] && [ -n "${GH_PAT:-}" ]; then
  echo "检测到扫码自愈新凭证，更新云端 Secret"
  GH_PAT="$GH_PAT" python3 scripts/put-secret.py new-session.b64 && rm -f new-session.b64
fi
