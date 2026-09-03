import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { credentialKey, tokenFor, storeToken } from '../build/credentials.js';

const run = promisify(execFile);

/** A stand-in dispatch service that only implements the pairing endpoints. */
async function withPairingServer(behaviour, run) {
  let approved = false;
  const server = createServer((req, res) => {
    const json = body => {
      const payload = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (req.url === '/api/pair/start') {
      json({
        userCode: 'WQ7F-2K9P',
        deviceCode: 'device-code',
        verificationUri: 'http://127.0.0.1/link',
        intervalSeconds: 0.05,
        expiresInSeconds: 10,
      });
      return;
    }
    if (req.url === '/api/pair/claim') {
      json(behaviour(() => { approved = true; }, approved));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('a token is keyed on the origin, so ws and https share one entry', () => {
  assert.equal(credentialKey('wss://tmux.example.com/agent'), 'https://tmux.example.com');
  assert.equal(credentialKey('https://tmux.example.com/'), 'https://tmux.example.com');
  assert.equal(credentialKey('ws://127.0.0.1:7676/agent'), 'http://127.0.0.1:7676');
});

test('a stored token is found again by the url the server dials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cred-'));
  const path = join(dir, 'credentials.json');
  await storeToken('https://tmux.example.com', 'secret-token', path);

  assert.equal(await tokenFor('wss://tmux.example.com/agent', path), 'secret-token');
  assert.equal(await tokenFor('https://other.example.com', path), undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('dispatch-login prints the code, waits, and stores the token it is given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cred-'));
  let polls = 0;
  await withPairingServer(() => {
    polls += 1;
    // Pending on the first poll, ready afterwards: the CLI must keep waiting.
    return polls < 2 ? { status: 'pending' } : { status: 'ready', token: 'device-token-abc' };
  }, async url => {
    const { stdout } = await run(process.execPath, [
      'build/index.js', 'dispatch-login', `--url=${url}`, '--name=test-machine', `--state-dir=${dir}`,
    ], { cwd: process.cwd() });

    assert.match(stdout, /WQ7F-2K9P/);
    assert.match(stdout, /Paired as "test-machine"/);

    const stored = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'));
    assert.equal(stored.tokens[credentialKey(url)], 'device-token-abc');
  });
});

test('a denied pairing fails cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cred-'));
  await withPairingServer(() => ({ status: 'denied' }), async url => {
    await assert.rejects(
      () => run(process.execPath, [
        'build/index.js', 'dispatch-login', `--url=${url}`, `--state-dir=${dir}`,
      ], { cwd: process.cwd() }),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /denied in the browser/);
        return true;
      }
    );
  });
});

test('an unreachable dispatch service fails with the address named', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tmux-mcp-cred-'));
  await assert.rejects(
    () => run(process.execPath, [
      'build/index.js', 'dispatch-login', '--url=http://127.0.0.1:1', `--state-dir=${dir}`,
    ], { cwd: process.cwd() }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /Could not reach http:\/\/127\.0\.0\.1:1/);
      return true;
    }
  );
});
