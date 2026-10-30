// server.js
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { firefox } = require('playwright');

const PORT = parseInt(process.env.PORT || '3000', 10);
const READY_SELECTOR = process.env.READY_SELECTOR || '#app *';
const BODY_READY_SELECTOR = process.env.BODY_READY_SELECTOR ?? 'article, main';
const READY_TIMEOUT  = parseInt(process.env.READY_TIMEOUT || '15000', 10);
const SETTLE_MS      = parseInt(process.env.SETTLE_MS || '200', 10);
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '20000', 10);
const CONTEXT_CLOSE_TIMEOUT_MS = 1500;
const MEMORY_CHECK_INTERVAL_MS = 100;
const RENDER_MEMORY_LIMIT_BYTES = parseInt(process.env.RENDER_MEMORY_LIMIT_MB || '450', 10) * 1024 * 1024;
const RENDER_MEMORY_RESUME_BYTES = parseInt(process.env.RENDER_MEMORY_RESUME_MB || '400', 10) * 1024 * 1024;
const CONCURRENCY    = parseInt(process.env.CONCURRENCY || '1', 10);
const BLOCK_TYPES    = new Set((process.env.BLOCK_TYPES || 'image,media,font').split(',').map(s=>s.trim()));

// Cache 參數
const CACHE_TTL_MS   = parseInt(process.env.CACHE_TTL_MS || '300000', 10); // 5 分鐘
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '1000', 10);
const CACHE_MAX_BYTES = parseInt(process.env.CACHE_MAX_BYTES || String(32 * 1024 * 1024), 10);
const CACHE_MAX_ENTRY_BYTES = parseInt(process.env.CACHE_MAX_ENTRY_BYTES || String(1024 * 1024), 10);

// === 極簡 LRU + TTL ===
class LRUCache {
  constructor(maxEntries, ttl, maxBytes, maxEntryBytes) {
    this.max = maxEntries; this.ttl = ttl;
    this.maxBytes = maxBytes; this.maxEntryBytes = maxEntryBytes;
    this.bytes = 0;
    this.map = new Map(); // key -> { html, etag, ts, hits }
  }
  _isExpired(entry){ return (Date.now() - entry.ts) > this.ttl; }
  _remove(key){
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.bytes -= entry.bytes;
    return true;
  }
  _pruneExpired(){
    for (const [key, entry] of this.map) {
      if (this._isExpired(entry)) this._remove(key);
    }
  }
  get(key){
    const e = this.map.get(key);
    if (!e) return null;
    if (this._isExpired(e)) { this._remove(key); return null; }
    // LRU：移到最後
    this.map.delete(key); this.map.set(key, e);
    e.hits = (e.hits||0)+1;
    return e;
  }
  set(key, val){
    this._pruneExpired();
    const bytes = Buffer.byteLength(val.html, 'utf8');
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    this._remove(key);
    this.map.set(key, { ...val, ts: Date.now(), hits: 0, bytes });
    this.bytes += bytes;
    // 超過項目數或位元組上限，踢掉最舊項目
    while (this.map.size > this.max || this.bytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      this._remove(oldestKey);
    }
    return true;
  }
  del(key){ return this._remove(key); }
  has(key){ return !!this.get(key); }
  stats(){
    this._pruneExpired();
    return { entries: this.map.size, approxBytes: this.bytes, ttlMs: this.ttl, max: this.max, maxBytes: this.maxBytes };
  }
  keys(){ return [...this.map.keys()]; }
}
const cache = new LRUCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS, CACHE_MAX_BYTES, CACHE_MAX_ENTRY_BYTES);
const markdownCacheKey = (url) => `markdown:${url}`;
const bodyCacheKey = (url) => `body:${url}`;

// === Playwright 基礎 ===
let browser;
let browserLaunch;
let cleanupPending = false;
let memoryPressure = false;
let running = 0;

function timeoutError(message = `Render exceeded ${RENDER_TIMEOUT_MS}ms`) {
  const error = new Error(message);
  error.statusCode = 504;
  error.rendererTimeout = true;
  return error;
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now());
}

function withDeadline(promise, deadline) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), remaining(deadline));
    }),
  ]).finally(() => clearTimeout(timer));
}

function withRenderGuard(promise, deadline, memoryGuard) {
  return Promise.race([withDeadline(promise, deadline), memoryGuard]);
}

function updateMemoryPressure() {
  let memoryBytes;
  try {
    memoryBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) return false;

  try {
    const memoryStat = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const inactiveFile = memoryStat.match(/^inactive_file\s+(\d+)$/m);
    if (inactiveFile) memoryBytes = Math.max(0, memoryBytes - Number(inactiveFile[1]));
  } catch {}

  if (memoryPressure) {
    if (memoryBytes <= RENDER_MEMORY_RESUME_BYTES) memoryPressure = false;
  } else if (memoryBytes >= RENDER_MEMORY_LIMIT_BYTES) {
    memoryPressure = true;
  }
  return memoryPressure;
}

function memoryLimitError() {
  const error = new Error('Renderer memory limit reached');
  error.statusCode = 503;
  error.memoryPressure = true;
  return error;
}

async function ensureBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserLaunch) {
    browserLaunch = firefox.launch({
      headless: true,
      args: ['--no-sandbox'],
      firefoxUserPrefs: {
        'dom.ipc.processCount': 1,
        'browser.cache.memory.capacity': 16384,
        'browser.cache.disk.enable': false,
        'browser.sessionhistory.max_total_viewers': 0,
      },
      timeout: RENDER_TIMEOUT_MS,
    })
      .then(instance => {
        browser = instance;
        return instance;
      })
      .finally(() => { browserLaunch = undefined; });
  }
  return browserLaunch;
}

async function render(url, forceBody = false) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let activeBrowser;
  let ctx;
  let page;
  let html;
  let failure;
  let memoryMonitor;
  let rejectMemoryGuard;
  let memoryGuardTriggered = false;
  const memoryGuard = new Promise((_, reject) => { rejectMemoryGuard = reject; });

  const guardMemory = () => {
    const pressure = updateMemoryPressure();
    if (memoryGuardTriggered || !pressure) return;
    memoryGuardTriggered = true;
    rejectMemoryGuard(memoryLimitError());
  };

  try {
    if (updateMemoryPressure()) throw memoryLimitError();
    memoryMonitor = setInterval(guardMemory, MEMORY_CHECK_INTERVAL_MS);
    activeBrowser = await withRenderGuard(ensureBrowser(), deadline, memoryGuard);
    ctx = await withRenderGuard(activeBrowser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; PlaywrightPrerender/1.1)',
    }), deadline, memoryGuard);
    page = await withRenderGuard(ctx.newPage(), deadline, memoryGuard);

    await withRenderGuard(page.route('**/*', (route) => {
      const req = route.request();
      if (BLOCK_TYPES.has(req.resourceType())) return route.abort();
      return route.continue();
    }), deadline, memoryGuard);

    await withRenderGuard(page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(READY_TIMEOUT, remaining(deadline)),
    }), deadline, memoryGuard);

    const ok = await withRenderGuard(Promise.any([
      page.waitForFunction(({ selector, forceBody }) => {
        if (forceBody) {
          return !!selector && Array.from(document.querySelectorAll(selector))
            .some(element => (element.textContent || '').trim().length > 0);
        }
        const title = (document.querySelector('title')?.textContent || document.title || '').trim();
        if (title.length > 0) return true;
        const app = document.querySelector('#app');
        return !!app && (app.children.length > 0 || !!document.querySelector(selector));
      }, { selector: forceBody ? BODY_READY_SELECTOR : READY_SELECTOR, forceBody }, {
        timeout: Math.min(READY_TIMEOUT, remaining(deadline)),
      }).then(()=>true),
      page.waitForLoadState('networkidle', {
        timeout: Math.min(READY_TIMEOUT, remaining(deadline)),
      }).then(()=>true),
    ]).catch(()=>false), deadline, memoryGuard);

    if (ok || forceBody) {
      await withRenderGuard(page.waitForTimeout(Math.min(SETTLE_MS, remaining(deadline))), deadline, memoryGuard);
    }
    html = await withRenderGuard(page.content(), deadline, memoryGuard);
  } catch (error) {
    failure = error;
    if (error.name === 'TimeoutError' || /timed out|timeout/i.test(error.message || '')) {
      error.statusCode = 504;
      error.rendererTimeout = true;
    }
  } finally {
    if (memoryMonitor) clearInterval(memoryMonitor);
    if (ctx) {
      let timer;
      const cleanupDeadline = Date.now() + CONTEXT_CLOSE_TIMEOUT_MS;
      try {
        if (page && !page.isClosed()) {
          await withDeadline(page.close({ runBeforeUnload: false }), cleanupDeadline);
        }
      } catch {}

      const contextClose = Promise.resolve().then(() => ctx.close());
      const closed = await Promise.race([
        contextClose.then(() => true, () => false),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), Math.max(1, cleanupDeadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);

      if (!closed) {
        cleanupPending = true;
        const releaseOnDisconnect = () => { cleanupPending = false; };
        activeBrowser?.once('disconnected', releaseOnDisconnect);
        contextClose.then(
          () => {
            cleanupPending = false;
            activeBrowser?.off('disconnected', releaseOnDisconnect);
          },
          () => {
            if (!activeBrowser?.isConnected()) {
              cleanupPending = false;
              activeBrowser?.off('disconnected', releaseOnDisconnect);
            }
          },
        );
        failure ||= timeoutError('Firefox page context did not close in time');
      }
    }
  }

  if (failure) throw failure;
  return html;
}

// Fail fast under load so renderer calls cannot occupy every application worker.
function enqueue(fn) {
  if (updateMemoryPressure() || cleanupPending || running >= CONCURRENCY) {
    const message = memoryPressure ? 'Renderer memory limit reached'
      : cleanupPending ? 'Previous page is still closing' : 'Renderer is busy';
    const error = new Error(message);
    error.statusCode = 503;
    return Promise.reject(error);
  }

  running++;
  return Promise.resolve().then(fn).finally(() => { running--; });
}

// 工具：產生 ETag
function makeETag(html){
  return `"W/${crypto.createHash('sha1').update(html).digest('hex')}"`;
}

async function sendRenderedResponse(req, res, html, target, asMarkdown, fromCache) {
  const body = asMarkdown
    ? (await import('markdown-for-agents')).convert(html, { baseUrl: target }).markdown
    : html;
  const etag = makeETag(body);

  if (fromCache && req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS/1000)}`);
    return res.end();
  }

  res.setHeader('Content-Type', asMarkdown ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS/1000)}`);
  res.end(body);
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
      const markdownExisted = cache.del(markdownCacheKey(target));
      const bodyExisted = cache.del(bodyCacheKey(target));
      return res.end(existed || markdownExisted || bodyExisted ? 'OK PURGED' : 'MISS');
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
    const asMarkdown = ['1', 'true'].includes((u.searchParams.get('markdown') || '').toLowerCase());
    const forceBody = ['1', 'true'].includes((u.searchParams.get('body') || '').toLowerCase());
    const renderBody = asMarkdown || forceBody;

    console.log(`Render request for: ${target}`);

    // 先查快取
    const renderCacheKey = asMarkdown ? markdownCacheKey(target) : forceBody ? bodyCacheKey(target) : target;
    const cached = cache.get(renderCacheKey);
    if (cached) {
      return sendRenderedResponse(req, res, cached.html, target, asMarkdown, true);
    }

    // 沒命中 -> 渲染
    const html = await enqueue(() => render(target, renderBody));
    cache.set(renderCacheKey, { html });
    await sendRenderedResponse(req, res, html, target, asMarkdown, false);

  } catch (e) {
    res.statusCode = e.statusCode || 500;
    const body = `Render error: ${e.message || e}`;
    res.end(body);
  }
});

// 優雅關閉
server.listen(PORT, () => console.log(`Playwright Firefox prerender + cache on :${PORT}`));
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
