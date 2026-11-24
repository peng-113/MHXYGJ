#!/usr/bin/env python3
"""更新 GitHub Secret SESSION_STATE。
格式约定（与 monitor.js 对齐）：Secret = base64(明文 storageState JSON)。
GitHub Secrets 本身已加密存储，不需要额外的 sealed box 封装。
输入文件自动识别：明文 JSON（本地 session-state.json）或 base64 文本（CI 端 new-session.b64）。
token 从 env GH_PAT 读取；仓库从 env GITHUB_REPOSITORY 读取（本地可缺省）。
用法：GH_PAT=xxx python3 scripts/put-secret.py [输入文件]
"""
import base64
import json
import os
import sys
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "peng-113/MHXYGJ")
TOKEN = os.environ.get("GH_PAT", "")
SECRET_NAME = "SESSION_STATE"


def api(url, method="GET", data=None):
    req = urllib.request.Request(
        url, method=method,
        headers={
            "Authorization": "token " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        data=json.dumps(data).encode() if data is not None else None,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return json.loads(body) if body else {}


def load_storage_b64(path):
    raw = open(path, "rb").read()
    # 尝试按 base64 解码并验证是合法 storageState（CI 端 new-session.b64 走这条）
    try:
        decoded = base64.b64decode(raw, validate=True)
        json.loads(decoded)
        return base64.b64encode(decoded).decode()
    except Exception:
        pass
    # 否则按明文 JSON 处理（本地 session-state.json 走这条）
    json.loads(raw)
    return base64.b64encode(raw).decode()


def main():
    if not TOKEN:
        print("错误：未设置 GH_PAT 环境变量（需要具有 repo 权限的 token）")
        sys.exit(1)
    src = sys.argv[1] if len(sys.argv) > 1 else "new-session.b64"
    b64 = load_storage_b64(src)  # 这就是 CI 运行时 secrets.SESSION_STATE 拿到的值，必须是 base64(JSON)
    # GitHub Secrets API 要求用仓库公钥做 sealed box 加密后上传，CI 端会自动解密还原
    from nacl.public import PublicKey, SealedBox
    pk = api("https://api.github.com/repos/%s/actions/secrets/public-key" % REPO)
    box = SealedBox(PublicKey(base64.b64decode(pk["key"]))).encrypt(b64.encode("utf8"))
    api("https://api.github.com/repos/%s/actions/secrets/%s" % (REPO, SECRET_NAME), "PUT",
        {"encrypted_value": base64.b64encode(box).decode(), "key_id": pk["key_id"]})
    print("✅ SESSION_STATE 已更新（base64 格式），下次运行监控自动恢复")


if __name__ == "__main__":
    main()
