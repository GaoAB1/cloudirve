# Cloudirve Drive MVP 生产镜像
# 零 npm 依赖的 Node 应用，无需构建阶段，单阶段镜像即可；元数据与文件统一落在 /app/data。
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1

CMD ["node", "src/server.js"]
