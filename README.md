# docker-prerender

Playwright Firefox prerender service with HTML/Markdown output and a five-minute memory cache.

```sh
docker build -t prerender .
docker run --rm -p 3000:3000 prerender
curl --get http://localhost:3000/render \
  --data-urlencode 'url=https://staging.lis.org.tw/posts/271' \
  --data 'body=true'
```

Only `body=true` or `markdown=true` enables full-body readiness. Plain HTML requests
keep the original title/app readiness and do not wait for article/main content.

Use `markdown=true` for Markdown output. Body and Markdown modes wait for nonempty
text in any element matching `BODY_READY_SELECTOR` (default: `article, main`), or
for network idle, whichever happens first. They then allow `SETTLE_MS` (default:
200 ms) before capturing. When no element matches, they fall back to network idle
or `READY_TIMEOUT` (default: 15000 ms).

Override `BODY_READY_SELECTOR` to target content specific to the site. For example,
to consider only articles:

```sh
docker run --rm -p 3000:3000 -e BODY_READY_SELECTOR=article prerender
```

If a page fills its body in multiple stages, use a more specific selector for the
final content; the first article/main text does not guarantee later API updates
have completed. Set `BODY_READY_SELECTOR` to an empty string to disable the
selector shortcut and wait only for network idle:

```sh
docker run --rm -p 3000:3000 -e BODY_READY_SELECTOR= prerender
```

`READY_SELECTOR` (default: `#app *`) still applies only to normal HTML mode.

Firefox is reused between requests and relaunched on the next request after it
disconnects. Browser contexts are closed even when navigation fails.

Tests use real Firefox against local fixtures and require Node.js 20+:

```sh
npm ci
npx playwright install firefox
npm test
```
