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
    if (req.url === '/body') {
      setTimeout(() => res.end('Complete API article body'), 900);
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
  const render = vm.runInNewContext(`${source}\nrender;`, {
    require(name) {
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      if (name === 'playwright') return { firefox: {
        async launch(options) {
          const browser = await firefox.launch(options);
          browsers.push(browser);
          return browser;
        },
      } };
      return require(name);
    },
    process: { env: { READY_TIMEOUT: '1800', SETTLE_MS: '20', ...env }, on() {} },
    console, URL, Buffer,
  }, { filename: path.join(__dirname, 'server.js') });

  return { render, browsers, url: `http://127.0.0.1:${fixture.address().port}` };
}

test('a render recovers after Firefox disconnects', async t => {
  const { render, browsers, url } = await renderer(t);
  await render(url);
  await browsers[0].close();

  const html = await render(url);

  assert.match(html, /Generic page content/);
  assert.equal(browsers.length, 2);
});

test('simultaneous cold renders share one browser', async t => {
  const { render, browsers, url } = await renderer(t);

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
