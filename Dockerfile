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
    RENDER_TIMEOUT_MS=20000 \
    RENDER_MEMORY_LIMIT_MB=450 \
    RENDER_MEMORY_RESUME_MB=400 \
    SETTLE_MS=200 \
    CONCURRENCY=1 \
    CACHE_MAX_BYTES=33554432 \
    CACHE_MAX_ENTRY_BYTES=1048576 \
    BLOCK_TYPES="image,media,font"

EXPOSE 3000
CMD ["node", "server.js"]
