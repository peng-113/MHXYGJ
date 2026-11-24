#!/usr/bin/env python3
"""GitHub Actions 内使用：把扫码登录导出的 new-session.b64 加密后更新 SESSION_STATE Secret。
用法：python3 scripts/put-secret.py <new-session.b64>   （token 从 env GH_PAT 读取，仓库从 GITHUB_REPOSITORY 读取）"""
import base64
import json
import os
import sys
import urllib.request

try:
    from nacl.public import PublicKey, SealedBox
except ImportError:
    os.system("python3 -m pip install --quiet pynacl")
    from nacl.public import PublicKey, SealedBox

REPO = os.environ.get("GITHUB_REPOSITORY", "peng-113/MHXYGJ")
TOKEN = os.environ.get("GH_PAT", "")


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


def main():
    if not TOKEN:
        print("未配置 MONITOR_PAT，无法自动更新 Secret")
        sys.exit(1)
    src = sys.argv[1] if len(sys.argv) > 1 else "new-session.b64"
    state = open(src, "rb").read()
    json.loads(base64.b64decode(state))  # 校验是合法 storageState
    print("读取仓库公钥…")
    pk = api("https://api.github.com/repos/%s/actions/secrets/public-key" % REPO)
    enc = SealedBox(PublicKey(base64.b64decode(pk["key"]))).encrypt(state)
    api("https://api.github.com/repos/%s/actions/secrets/SESSION_STATE" % REPO, "PUT",
        {"encrypted_value": base64.b64encode(enc).decode(), "key_id": pk["key_id"]})
    print("✅ SESSION_STATE Secret 已自动更新，下次运行使用扫码登录的新凭证")


if __name__ == "__main__":
    main()
