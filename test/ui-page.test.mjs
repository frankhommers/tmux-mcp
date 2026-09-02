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

test('the page is served, and carries the token from the query string', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /app\.css/);
  });
});

test('a deep link to one request serves the same page', async () => {
  await withDaemon(async daemon => {
    const res = await fetch(`${daemon.url}/r/r-abc123?t=${daemon.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('the page assets are served with the right content types', async () => {
  await withDaemon(async daemon => {
    const css = await fetch(`${daemon.url}/app.css?t=${daemon.token}`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${daemon.url}/app.js?t=${daemon.token}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});

test('the app shell loads the way a browser loads it', async () => {
  await withDaemon(async daemon => {
    // A browser fetches the page with the token in the query string, but
    // requests app.js and app.css as subresources: no header, no query.
    // Requiring a token on those leaves a page that never runs its script.
    assert.equal((await fetch(`${daemon.url}/?t=${daemon.token}`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/app.js`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/app.css`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/r/r-abc123`)).status, 200);
  });
});

test('data still needs a token, even though the shell does not', async () => {
  await withDaemon(async daemon => {
    assert.equal((await fetch(`${daemon.url}/api/requests`)).status, 401);
    assert.equal((await fetch(`${daemon.url}/events`)).status, 401);
  });
});
