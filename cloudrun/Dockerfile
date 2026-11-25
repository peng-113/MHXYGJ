FROM mcr.microsoft.com/playwright:v1.49.0-noble

# 中文字体（二维码页面/搜索页渲染）+ git + python3/pip（put-secret.py 依赖 pynacl）
# playwright npm 包：镜像自带浏览器但不含 npm 包，全局安装（跳过浏览器下载）
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g playwright@1.49.0 \
  && apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk git python3 python3-pip ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && (pip3 install --break-system-packages pynacl 2>/dev/null || pip3 install pynacl) \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

WORKDIR /app
COPY server.js run.sh /app/
RUN chmod +x /app/run.sh

EXPOSE 8080
ENV TZ=Asia/Shanghai NODE_PATH=/usr/lib/node_modules
CMD ["node", "/app/server.js"]
