// server.js
const http = require('http');
const crypto = require('crypto');
const { firefox } = require('playwright');

const PORT = parseInt(process.env.PORT || '3000', 10);
const READY_SELECTOR = process.env.READY_SELECTOR || '#app *';
const READY_TIMEOUT  = parseInt(process.env.READY_TIMEOUT || '15000', 10);
const SETTLE_MS      = parseInt(process.env.SETTLE_MS || '200', 10);
const CONCURRENCY    = parseInt(process.env.CONCURRENCY || '2', 10);
const BLOCK_TYPES    = new Set((process.env.BLOCK_TYPES || 'image,media,font,stylesheet').split(',').map(s=>s.trim()));

// Cache 參數
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '300000', 10); // 5 分鐘
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '1000', 10);

// === 極簡 LRU + TTL ===
class LRUCache {
  constructor(maxEntries, ttl) {
    this.max = maxEntries; this.ttl = ttl;
    this.map = new Map(); // key -> { html, etag, ts, hits }
  }
  _isExpired(entry){ return (Date.now() - entry.ts) > this.ttl; }
  get(key){
    const e = this.map.get(key);
    if (!e) return null;
    if (this._isExpired(e)) { this.map.delete(key); return null; }
    // LRU：移到最後
    this.map.delete(key); this.map.set(key, e);
    e.hits = (e.hits||0)+1;
    return e;
  }
  set(key, val){
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { ...val, ts: Date.now(), hits: 0 });
    // 超過容量，踢掉最舊
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
  del(key){ return this.map.delete(key); }
  has(key){ return !!this.get(key); }
  stats(){
    let size = 0;
    for (const v of this.map.values()) size += Buffer.byteLength(v.html, 'utf8');
    return { entries: this.map.size, approxBytes: size, ttlMs: this.ttl, max: this.max };
  }
  keys(){ return [...this.map.keys()]; }
}
const cache = new LRUCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

// === Playwright 基礎 ===
let browser;
const queue = [];
let running = 0;

async function ensureBrowser() {
  if (!browser) {
    browser = await firefox.launch({ headless: true, args: ['--no-sandbox'] });
  }
}

async function render(url) {
  await ensureBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; PlaywrightPrerender/1.1)',
  });
  const page = await ctx.newPage();

  await page.route('**/*', (route) => {
    const req = route.request();
    if (BLOCK_TYPES.has(req.resourceType())) return route.abort();
    return route.continue();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT });

  const ok = await Promise.race([
    page.waitForFunction((sel) => {
      const title = (document.querySelector('title')?.textContent || document.title || '').trim();
      console.log(`Detected title: "${title}"`);
      if (title.length > 0) return true;
      const app = document.querySelector('#app');
      console.log(`Detected app element: ${app ? 'YES' : 'NO'}`);
      return !!app && (app.children.length > 0 || !!document.querySelector(sel));
    }, READY_SELECTOR, { timeout: READY_TIMEOUT }).then(()=>true).catch(()=>false),
    page.waitForLoadState('networkidle', { timeout: READY_TIMEOUT }).then(()=>true).catch(()=>false),
  ]);

  if (ok) await page.waitForTimeout(SETTLE_MS);
  const html = await page.content();
  await ctx.close();
  return html;
}

// 併發隊列
function enqueue(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); drain(); });
}
async function drain() {
  if (running >= CONCURRENCY || queue.length === 0) return;
  const item = queue.shift(); running++;
  try { item.resolve(await item.fn()); }
  catch (e) { item.reject(e); }
  finally { running--; drain(); }
}

// 工具：產生 ETag
function makeETag(html){
  return `"W/${crypto.createHash('sha1').update(html).digest('hex')}"`;
}

// 預熱
async function prewarm(url){
  if (cache.get(url)) return 'HIT';
  const html = await enqueue(() => render(url));
  cache.set(url, { html, etag: makeETag(html) });
  return 'MISS->SET';
}

// HTTP 服務
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;

    // 健康檢查
    if (pathname === '/healthz') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }

    // 快取統計
    if (pathname === '/_cache_stats') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ...cache.stats(), keys: cache.keys().slice(0,50) }));
    }

    // 清除快取：/purge?url=...
    if (pathname === '/purge') {
      const target = u.searchParams.get('url');
      if (!target) { res.statusCode = 400; return res.end('missing ?url='); }
      const existed = cache.del(target);
      return res.end(existed ? 'OK PURGED' : 'MISS');
    }

    // 預熱：/prewarm?url=...
    if (pathname === '/prewarm') {
      const target = u.searchParams.get('url');
      if (!target) { res.statusCode = 400; return res.end('missing ?url='); }
      const r = await prewarm(target);
      return res.end(`PREWARM ${r}`);
    }

    if (pathname !== '/render' && !/^http(s)?/.test(pathname.slice(1))) {
      res.statusCode = 404; return res.end('not found');
    }

    const target = /^http(s)?/.test(pathname.slice(1)) ? decodeURIComponent(pathname.slice(1)) : u.searchParams.get('url');
    if (!target) {
      res.statusCode = 400; return res.end('missing ?url=');
    }

    console.log(`Render request for: ${target}`);

    // 先查快取
    const cached = cache.get(target);
    if (cached) {
      // 支援 If-None-Match
      const inm = req.headers['if-none-match'];
      if (inm && inm === cached.etag) {
        res.statusCode = 304;
        res.setHeader('ETag', cached.etag);
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS/1000)}`);
        return res.end();
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('ETag', cached.etag);
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS/1000)}`);
      return res.end(cached.html);
    }

    // 沒命中 -> 渲染
    const html = await enqueue(() => render(target));
    const etag = makeETag(html);
    cache.set(target, { html, etag });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS/1000)}`);
    res.end(html);

  } catch (e) {
    res.statusCode = 500;
    res.end(`Render error: ${e.message || e}`);
  }
});

// 優雅關閉
server.listen(PORT, () => console.log(`Playwright Firefox prerender + cache on :${PORT}`));
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
