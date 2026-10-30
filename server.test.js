const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { firefox } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

async function renderer(t, env = {}) {
  const browsers = [];
  const browserLaunchOptions = [];
  let browserCloseCalls = 0;
  let memoryUsageBytes = Number(env.MEMORY_USAGE_BYTES || 0);
  let inactiveFileBytes = Number(env.INACTIVE_FILE_BYTES || 0);
  let handleRequest;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/tracking') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('waiting');
      return;
    }
    if (req.url === '/disconnect') {
      req.socket.destroy();
      return;
    }
    if (req.url === '/hang') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.flushHeaders();
      return;
    }
    if (req.url === '/body') {
      setTimeout(() => res.end('Complete API article body'), 900);
      return;
    }
    if (req.url === '/route-css') {
      res.end(`<html><head><title>CSS route</title></head><body>
        <div id="app"><main id="page-content"></main></div>
        <script>
          const stylesheet = document.createElement('link');
          stylesheet.rel = 'stylesheet';
          stylesheet.href = '/route.css';
          stylesheet.onload = () => {
            document.querySelector('#page-content').textContent = 'Rendered route body';
          };
          document.head.appendChild(stylesheet);
        </script></body></html>`);
      return;
    }
    if (req.url === '/route.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end('body { color: red; }');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/loading-article') {
      res.end(`<html><head><title>Preloaded title</title></head><body>
        <div id="app"><article><h1>Article heading</h1><section id="body">Loading</section></article></div>
        <script>fetch('/body').then(r => r.text()).then(text => document.querySelector('#body').textContent = text);</script>
        </body></html>`);
      return;
    }
    if (['/delayed', '/custom', '/delayed-main', '/delayed-second'].includes(req.url)) {
      const closingTag = req.url === '/custom' ? 'section'
        : req.url === '/delayed-main' || req.url === '/delayed-second' ? 'main' : 'article';
      const tag = req.url === '/custom' ? 'section class="body-ready"' : closingTag;
      const emptyArticle = req.url === '/delayed-second' ? '<article></article>' : '';
      res.end(`<html><head><title>Preloaded title</title></head><body>
        <div id="app"><nav>Navigation already loaded</nav>${emptyArticle}<${tag}></${closingTag}></div>
        <script>
          fetch('/tracking');
          setTimeout(() => document.querySelector('${closingTag}').textContent = 'Complete article body', 250);
        </script></body></html>`);
      return;
    }
    const tracking = req.url === '/tracking-only' ? "<script>fetch('/tracking')</script>" : '';
    res.end(`<html><head><title>Ready</title></head><body><div id="app">Generic page content</div>${tracking}</body></html>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all(browsers.map(browser => browser.close()));
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  });

  // Load the existing entry point without opening its HTTP listener or signal handlers.
  const { render, enqueue, ensureBrowser, LRUCache, isCleanupPending, checkMemoryPressure } = vm.runInNewContext(`${source}\n({ render, enqueue, ensureBrowser, LRUCache, isCleanupPending: () => cleanupPending, checkMemoryPressure: updateMemoryPressure });`, {
    require(name) {
      if (name === 'http') return { createServer(handler) {
        handleRequest = handler;
        return { listen() {} };
      } };
      if (name === 'fs') return {
        readFileSync(file, ...args) {
          if (file === '/sys/fs/cgroup/memory.current') return String(memoryUsageBytes);
          if (file === '/sys/fs/cgroup/memory.stat') return `inactive_file ${inactiveFileBytes}\n`;
          return fs.readFileSync(file, ...args);
        },
      };
      if (name === 'playwright') return { firefox: {
        async launch(options) {
          browserLaunchOptions.push(options);
          const browser = await firefox.launch(options);
          browsers.push(browser);
          const newContext = browser.newContext.bind(browser);
          browser.newContext = async (...args) => {
            const context = await newContext(...args);
            if (env.HANG_CONTEXT_CLOSE === '1') context.close = () => new Promise(() => {});
            return context;
          };
          const close = browser.close.bind(browser);
          browser.close = async () => {
            browserCloseCalls++;
            return close();
          };
          return browser;
        },
      } };
      return require(name);
    },
    process: { env: { READY_TIMEOUT: '1800', SETTLE_MS: '20', ...env }, on() {} },
    console, URL, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: path.join(__dirname, 'server.js') });

  return { render, enqueue, ensureBrowser, LRUCache, isCleanupPending, checkMemoryPressure, setMemoryUsage: bytes => { memoryUsageBytes = bytes; }, setInactiveFileUsage: bytes => { inactiveFileBytes = bytes; }, handleRequest, browsers, browserLaunchOptions, browserCloseCalls: () => browserCloseCalls, url: `http://127.0.0.1:${fixture.address().port}` };
}

test('rejects renders immediately when all render slots are busy', async t => {
  const { enqueue } = await renderer(t, { CONCURRENCY: '1' });
  let release;
  let queuedRenderStarted = false;
  const activeRender = enqueue(() => new Promise(resolve => { release = resolve; }));
  const excessRender = enqueue(() => {
    queuedRenderStarted = true;
    return 'rendered';
  });

  const result = await Promise.race([
    excessRender.then(() => 'accepted', error => error),
    new Promise(resolve => setTimeout(() => resolve('waited'), 50)),
  ]);
  release();
  await Promise.all([activeRender, excessRender.catch(() => {})]);

  assert.equal(result.statusCode, 503);
  assert.equal(queuedRenderStarted, false);
});

test('returns 503 to clients when all render slots are busy', async t => {
  const { enqueue, handleRequest, url } = await renderer(t, { CONCURRENCY: '1' });
  let release;
  const activeRender = enqueue(() => new Promise(resolve => { release = resolve; }));
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
  const request = handleRequest({
    url: `/render?url=${encodeURIComponent(url)}`,
    headers: {},
  }, response);
  const result = await Promise.race([
    request.then(() => 'responded'),
    new Promise(resolve => setTimeout(() => resolve('waited'), 50)),
  ]);
  release();
  await Promise.all([activeRender, request]);

  assert.equal(result, 'responded');
  assert.equal(response.statusCode, 503);
});

test('launches Firefox with low-memory process and cache limits', async t => {
  const { ensureBrowser, browserLaunchOptions } = await renderer(t);

  await ensureBrowser();

  assert.equal(browserLaunchOptions[0].firefoxUserPrefs['dom.ipc.processCount'], 1);
  assert.equal(browserLaunchOptions[0].firefoxUserPrefs['browser.cache.memory.capacity'], 16384);
  assert.equal(browserLaunchOptions[0].firefoxUserPrefs['browser.cache.disk.enable'], false);
});

test('bounds cached HTML by entry count and total bytes', async t => {
  const { LRUCache } = await renderer(t);
  const cache = new LRUCache(10, 1000, 5, 4);

  cache.set('first', { html: '1234' });
  cache.set('second', { html: '56' });
  cache.set('oversized', { html: '12345' });

  const stats = cache.stats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.approxBytes, 2);
  assert.equal(stats.maxBytes, 5);
  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second').html, '56');
  assert.equal(cache.get('oversized'), null);
});

test('applies one render deadline and closes only the timed-out page context', async t => {
  const { render, ensureBrowser, browsers, browserCloseCalls, url } = await renderer(t, {
    READY_TIMEOUT: '5000',
    RENDER_TIMEOUT_MS: '2500',
  });
  await ensureBrowser();
  const startedAt = Date.now();

  await assert.rejects(render(`${url}/hang`), error => error.statusCode === 504);

  assert.ok(Date.now() - startedAt < 4000, 'render and cleanup must finish within the hard deadline');
  assert.equal(browserCloseCalls(), 0, 'a timed-out page must not close Firefox');
  assert.equal(browsers[0].isConnected(), true, 'Firefox should remain available for later renders');
  assert.equal(browsers[0].contexts().length, 0, 'the timed-out page context must be closed');

  assert.match(await render(url), /Generic page content/);
  assert.equal(browsers.length, 1, 'the next render should reuse the same Firefox instance');
});

test('stops admitting renders if a page context cannot be closed', async t => {
  const { render, enqueue, ensureBrowser, browsers, isCleanupPending, url } = await renderer(t, {
    HANG_CONTEXT_CLOSE: '1',
    READY_TIMEOUT: '5000',
    RENDER_TIMEOUT_MS: '2500',
  });
  await ensureBrowser();

  await assert.rejects(render(`${url}/hang`), error => error.statusCode === 504);

  assert.equal(isCleanupPending(), true);
  assert.equal(browsers[0].isConnected(), true, 'Firefox stays up when a tab cleanup stalls');
  assert.equal(browsers[0].contexts().length, 1);
  await assert.rejects(enqueue(() => render(url)), error => error.statusCode === 503);
});

test('closes only the active tab at the memory guard and resumes below the low-water mark', async t => {
  const { render, enqueue, ensureBrowser, browsers, checkMemoryPressure, setMemoryUsage, url } = await renderer(t, {
    READY_TIMEOUT: '5000',
    RENDER_TIMEOUT_MS: '5000',
    MEMORY_USAGE_BYTES: String(300 * 1024 * 1024),
    RENDER_MEMORY_LIMIT_MB: '450',
    RENDER_MEMORY_RESUME_MB: '400',
  });
  await ensureBrowser();
  assert.equal(checkMemoryPressure(), false);

  const inFlightRender = render(`${url}/hang`);
  let pressureReached = false;
  setTimeout(() => {
    setMemoryUsage(470 * 1024 * 1024);
    pressureReached = checkMemoryPressure();
  }, 250);
  await assert.rejects(inFlightRender, error => error.statusCode === 503);

  assert.equal(pressureReached, true);
  assert.equal(browsers[0].isConnected(), true);
  assert.equal(browsers[0].contexts().length, 0);
  await assert.rejects(enqueue(() => render(url)), error => error.statusCode === 503);

  setMemoryUsage(350 * 1024 * 1024);
  assert.equal(await enqueue(() => 'renderer resumed'), 'renderer resumed');
  assert.equal(browsers[0].isConnected(), true);
});

test('does not trip the memory guard on reclaimable cgroup file cache', async t => {
  const { checkMemoryPressure, setMemoryUsage, setInactiveFileUsage } = await renderer(t, {
    MEMORY_USAGE_BYTES: String(470 * 1024 * 1024),
    INACTIVE_FILE_BYTES: String(100 * 1024 * 1024),
    RENDER_MEMORY_LIMIT_MB: '450',
  });

  assert.equal(checkMemoryPressure(), false);

  setMemoryUsage(549 * 1024 * 1024);
  setInactiveFileUsage(100 * 1024 * 1024);
  assert.equal(checkMemoryPressure(), false);

  setInactiveFileUsage(50 * 1024 * 1024);
  assert.equal(checkMemoryPressure(), true);
});

test('a render recovers after Firefox disconnects', async t => {
  const { render, browsers, url } = await renderer(t);
  await render(url);
  await browsers[0].close();

  const html = await render(url);

  assert.match(html, /Generic page content/);
  assert.equal(browsers.length, 2);
});

test('simultaneous cold renders share one browser', async t => {
  const { render, browsers, url } = await renderer(t, { CONCURRENCY: '2' });

  const results = await Promise.all([render(url), render(url)]);

  assert.ok(results.every(html => html.includes('Generic page content')));
  assert.equal(browsers.length, 1, 'only one Firefox process should be launched');
});

test('a failed navigation closes its browser context', async t => {
  const { render, browsers, url } = await renderer(t);

  await assert.rejects(render(`${url}/disconnect`));

  assert.equal(browsers[0].contexts().length, 0);
});

test('successful renders leave no open contexts or tabs', async t => {
  const { render, browsers, url } = await renderer(t);

  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match(await render(url), /Generic page content/);
    assert.equal(browsers.length, 1);
    assert.equal(browsers[0].contexts().length, 0);
    assert.equal(browsers[0].isConnected(), true);
  }
});

for (const [route, tag] of [['/delayed', 'article'], ['/delayed-main', 'main'], ['/delayed-second', 'main']]) {
  test(`default body readiness accepts ${route} without waiting for background requests`, async t => {
    const { render, url } = await renderer(t);
    await render(url);
    const start = Date.now();

    const html = await render(`${url}${route}`, true);

    assert.ok(html.includes(`<${tag}>Complete article body</${tag}>`));
    assert.ok(Date.now() - start < 1500, 'any nonempty article or main must release the render before timeout');
  });
}

test('normal HTML rendering does not wait for body selectors or background requests', async t => {
  const { render, url } = await renderer(t);
  await render(url);
  const start = Date.now();

  const html = await render(`${url}/tracking-only`);

  assert.match(html, /Generic page content/);
  assert.ok(Date.now() - start < 1500, 'only explicit body rendering should wait for body readiness');
});

test('body rendering honors a custom readiness selector', async t => {
  const { render, url } = await renderer(t, { BODY_READY_SELECTOR: '.body-ready' });
  await render(url);
  const start = Date.now();

  const html = await render(`${url}/custom`, true);

  assert.match(html, /<section class="body-ready">Complete article body<\/section>/);
  assert.ok(Date.now() - start < 1500, 'the configured body must release the render before timeout');
});

test('pages without an article or main still complete through network idle', async t => {
  const { render, url } = await renderer(t);

  assert.match(await render(url, true), /Generic page content/);
});

test('a CSS-dependent route renders after its stylesheet loads', async t => {
  const { render, url } = await renderer(t);

  const html = await render(`${url}/route-css`, true);

  assert.match(html, /<main id="page-content">Rendered route body<\/main>/);
});

test('an empty body selector waits for the API body even when an article heading is present', async t => {
  const { render, url } = await renderer(t, { SETTLE_MS: '200', BODY_READY_SELECTOR: '' });

  const html = await render(`${url}/loading-article`, true);

  assert.match(html, /<section id="body">Complete API article body<\/section>/);
});

test('an invalid body selector falls back to network idle instead of capturing a loading body', async t => {
  const { render, url } = await renderer(t, { SETTLE_MS: '200', BODY_READY_SELECTOR: '[' });

  const html = await render(`${url}/loading-article`, true);

  assert.match(html, /<section id="body">Complete API article body<\/section>/);
});
