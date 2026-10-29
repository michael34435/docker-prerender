FROM node:22-bookworm

WORKDIR /app
COPY package.json package-lock.json ./

# 依 lockfile 安裝 Playwright，並用同版本下載 Firefox 與系統依賴。
RUN npm ci && \
    npx playwright install --with-deps firefox

COPY . .

ENV PORT=3000 \
    READY_SELECTOR="#app *" \
    READY_TIMEOUT=15000 \
    SETTLE_MS=200 \
    CONCURRENCY=2 \
    BLOCK_TYPES="image,media,font"

EXPOSE 3000
CMD ["node", "server.js"]
