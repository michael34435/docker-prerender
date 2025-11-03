FROM node:20-bullseye

# 安裝 Playwright 及 Firefox 依賴
RUN npm i -g playwright && \
    npx playwright install --with-deps firefox

WORKDIR /app
COPY . .

RUN npm install

ENV PORT=3000 \
    READY_SELECTOR="#app *" \
    READY_TIMEOUT=15000 \
    SETTLE_MS=200 \
    CONCURRENCY=2 \
    BLOCK_TYPES="image,media,font,stylesheet"

EXPOSE 3000
CMD ["node", "server.js"]

