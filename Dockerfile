# SimpleCal —— 实验性 Dockerfile
#
# 数据目录走 CALDAV_DATA_DIR、前端目录走 CALDAV_WEB_DIR、端口走 CALDAV_PORT。
# 构建（在仓库根目录执行）：
#   docker build -t simplecal:dev .
# 运行：
#   docker run -d --name simplecal -p 5581:5280 -v simplecal-data:/data \
#     -e CALDAV_ADMIN_PASSWORD='换成你的强密码' simplecal:dev

# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web
WORKDIR /src
COPY code/web/package.json code/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY code/web/ ./
RUN node node_modules/vite/bin/vite.js build

# ---------- 阶段 2：运行 ----------
FROM node:22-alpine

# 通用数据根：accounts.json / calendars/ / ai/ / logs/ 全在它下面
ENV NODE_ENV=production \
    CALDAV_DATA_DIR=/data \
    CALDAV_HOST=0.0.0.0 \
    CALDAV_PORT=5280 \
    CALDAV_WEB_DIR=/app/www

WORKDIR /app

# 后端零第三方运行期依赖：只用 Node 内置模块 + 应用内 vendored 的 ical / bcryptjs
COPY code/app/ ./
COPY --from=web /src/dist ./www

# 测试代码与本地运行残留不进镜像
RUN rm -rf /app/test /app/var /app/.var-* /app/*.log \
 && mkdir -p /data \
 && chown -R node:node /app /data

# 非 root 运行（容器内端口 5280 > 1024，不需要特权）
USER node

VOLUME ["/data"]
EXPOSE 5280

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CALDAV_PORT||5280)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 首次启动可指定 CALDAV_ADMIN_PASSWORD 或 CALDAV_ADMIN_PASSWORD_FILE。
# 均不指定则生成随机密码，写入 /data/admin-initial-password.txt，首登强制改密。
CMD ["node", "server.mjs"]
