import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  checkCommandStatus,
  executeCommand,
  executeTmux,
  sendInterrupt,
} from '../build/tmux.js';

async function withFreshPane(run) {
  const sessionName = `tmux-mcp-command-status-${process.pid}-${randomUUID()}`;
  const paneId = await executeTmux([
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-P',
    '-F',
    '#{pane_id}',
  ]);
  try {
    await run(paneId);
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
}

async function waitForStatus(commandId, predicate) {
  const deadline = Date.now() + 2000;
  do {
    const status = await checkCommandStatus(commandId);
    if (status && predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  assert.fail('command status did not reach the expected state');
}

test('exposes output while a tracked command remains pending', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(
      paneId,
      'printf "  partial output"; sleep 10',
    );

    try {
      const status = await waitForStatus(
        commandId,
        current => current.status === 'pending' && current.result?.includes('partial output'),
      );

      assert.equal(status.status, 'pending');
      assert.equal(status.exitCode, undefined);
      assert.equal(status.result, '  partial output');
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('preserves pending output newlines after removing start framing', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(paneId, 'printf "\\nfirst\\n\\nsecond"; sleep 10');

    try {
      const status = await waitForStatus(
        commandId,
        current => current.status === 'pending' && current.result?.includes('second'),
      );

      assert.equal(status.result, '\nfirst\n\nsecond');
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('treats an end marker embedded in output as pending output', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(paneId, 'sleep 10');
    const embeddedMarker = `payloadTMUX_MCP_DONE_${commandId.slice(0, 8)}_7`;

    try {
      await waitForStatus(
        commandId,
        current => current.status === 'pending' && current.result === '',
      );
      await executeTmux(['send-keys', '-l', '-t', paneId, embeddedMarker]);
      await executeTmux(['send-keys', '-t', paneId, 'Enter']);

      const status = await waitForStatus(
        commandId,
        current => current.status !== 'pending' || current.result?.includes(embeddedMarker),
      );

      assert.equal(status.status, 'pending');
      assert.equal(status.exitCode, undefined);
      assert.match(status.result, new RegExp(embeddedMarker));
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('preserves final output and error status when the end marker appears', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(paneId, 'printf "  final output\\n"; exit 7');
    const status = await waitForStatus(commandId, current => current.status !== 'pending');

    assert.equal(status.status, 'error');
    assert.equal(status.exitCode, 7);
    assert.equal(status.result, '  final output\n');
  });
});

test('preserves completed output newlines while removing end framing', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(paneId, 'printf "\\nfirst\\n\\nsecond\\n"');
    const status = await waitForStatus(commandId, current => current.status !== 'pending');

    assert.equal(status.status, 'completed');
    assert.equal(status.result, '\nfirst\n\nsecond\n');
  });
});

test('completes with output when tty ONLCR is disabled', async () => {
  await withFreshPane(async (paneId) => {
    const commandId = await executeCommand(paneId, 'stty -onlcr; printf foo');
    const status = await waitForStatus(commandId, current => current.status !== 'pending');

    assert.equal(status.status, 'completed');
    assert.equal(status.exitCode, 0);
    assert.equal(status.result, 'foo');
  });
});
