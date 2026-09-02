import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startDaemon } from '../build/ui/daemon.js';

async function withDaemon(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tmux-mcp-ui-'));
  const daemon = await startDaemon({ stateDir, requestsDir: join(stateDir, 'requests'), port: 0 });
  try {
    await run(daemon);
  } finally {
    await daemon.close();
  }
}

test('the page is served and names its fingerprinted assets', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/);
    const style = html.match(/href="(\/assets\/[^"]+\.css)"/);
    assert.ok(script, `expected a built script tag, got: ${html}`);
    assert.ok(style, `expected a built stylesheet link, got: ${html}`);

    // The browser fetches those without any credentials.
    const js = await fetch(`${daemon.url}${script[1]}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(js.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(`${daemon.url}${style[1]}`)).status, 200);
  });
});

test('a deep link to one request serves the same page', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/r/r-abc123?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('a path outside the public directory is refused', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/assets/${encodeURIComponent('../../../etc/passwd')}`);
    assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  });
});

test('the app shell loads the way a browser loads it', async () => {
  await withDaemon(async daemon => {
    // A browser fetches the page with the token in the query string, but
    // requests app.js and app.css as subresources: no header, no query.
    // Requiring a token on those leaves a page that never runs its script.
    const html = await (await fetch(`${daemon.url}/?t=${daemon.token}`)).text();
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
    assert.equal((await fetch(`${daemon.url}${script}`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/r/r-abc123`)).status, 200);
  });
});

test('data still needs a token, even though the shell does not', async () => {
  await withDaemon(async daemon => {
    assert.equal((await fetch(`${daemon.url}/api/requests`)).status, 401);
    assert.equal((await fetch(`${daemon.url}/events`)).status, 401);
  });
});
