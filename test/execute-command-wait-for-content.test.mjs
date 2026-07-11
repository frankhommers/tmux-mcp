import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  executeCommandWaitForContent,
  executeTmux,
  sendInterrupt,
  waitForPaneContent,
  waitForPaneContentGone,
} from '../build/tmux.js';

async function withFreshPane(run) {
  const sessionName = `tmux-mcp-wait-content-${process.pid}-${randomUUID()}`;
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
    const idleCommand = await executeTmux([
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{pane_current_command}',
    ]);
    await run(paneId, idleCommand);
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
}

async function waitForCurrentCommand(paneId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const currentCommand = await executeTmux([
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{pane_current_command}',
    ]);
    if (currentCommand === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`pane did not start ${expected}`);
}

async function waitForPaneText(paneId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const content = await executeTmux(['capture-pane', '-p', '-t', paneId]);
    if (content.split('\n').some(line => line.trim() === expected)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`pane did not print ${expected}`);
}

test('matches immediate plain text after the command exits', async () => {
  await withFreshPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "READY\\n"',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 100 },
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.matchedLine, 'READY');
    assert.match(result.output, /READY/);
  });
});

test('matches one logical output line across narrow-pane soft wraps', async () => {
  await withFreshPane(async (paneId) => {
    await executeTmux(['resize-window', '-t', paneId, '-x', '20', '-y', '10']);
    const logicalLine = '123456789012345678READY_TOKEN';

    const result = await executeCommandWaitForContent(
      paneId,
      `printf "${logicalLine}\\n"`,
      'READY_TOKEN',
      { timeoutSeconds: 2, pollIntervalMs: 50 },
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.matchedLine, logicalLine);
    assert.match(result.output, new RegExp(logicalLine));
  });
});

test('matching output wins when the same poll observes command completion', async () => {
  await withFreshPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'sleep 0.05; printf "READY\\n"',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 250 },
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.commandStatus, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.matchedLine, 'READY');
  });
});

test('matches regex while the tracked command remains pending', async () => {
  await withFreshPane(async (paneId, idleCommand) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "Listening on port 3210\\n"; sleep 10',
      String.raw`Listening on port \d+`,
      { regex: true, timeoutSeconds: 2, pollIntervalMs: 100 },
    );

    try {
      assert.equal(result.status, 'matched');
      assert.equal(result.commandStatus, 'pending');
      assert.match(result.matchedLine, /Listening on port 3210/);
      const currentCommand = await executeTmux([
        'display-message',
        '-p',
        '-t',
        paneId,
        '#{pane_current_command}',
      ]);
      assert.notEqual(currentCommand, idleCommand);
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('reports a command that exits with an error before matching', async () => {
  await withFreshPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "NOPE\\n"; exit 7',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 100 },
    );

    assert.equal(result.status, 'exited_without_match');
    assert.equal(result.commandStatus, 'error');
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /NOPE/);
  });
});

test('reports a successful command that exits before matching', async () => {
  await withFreshPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "DONE\\n"',
      'READY',
      { timeoutSeconds: 2, pollIntervalMs: 100 },
    );

    assert.equal(result.status, 'exited_without_match');
    assert.equal(result.commandStatus, 'completed');
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /DONE/);
  });
});

test('matches output produced after multiple polls', async () => {
  await withFreshPane(async (paneId) => {
    const startedAt = Date.now();
    const result = await executeCommandWaitForContent(
      paneId,
      'sleep 0.3; printf "DELAYED_READY\\n"; sleep 10',
      'DELAYED_READY',
      { timeoutSeconds: 2, pollIntervalMs: 50 },
    );

    try {
      assert.equal(result.status, 'matched');
      assert.equal(result.commandStatus, 'pending');
      assert.equal(result.matchedLine, 'DELAYED_READY');
      assert.ok(Date.now() - startedAt >= 200);
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('times out when matching output is first observable after the deadline', async () => {
  await withFreshPane(async (paneId) => {
    await executeTmux(['send-keys', '-t', paneId, 'printf "WARM\\n"', 'Enter']);
    await waitForPaneText(paneId, 'WARM');

    const result = await executeCommandWaitForContent(
      paneId,
      'sleep 0.05; printf "LATE_READY\\n"',
      'LATE_READY',
      { timeoutSeconds: 0.1, pollIntervalMs: 200 },
    );

    assert.equal(result.status, 'timed_out');
    assert.equal(result.commandStatus, 'pending');
    assert.equal(result.matchedLine, undefined);
  });
});

test('times out without interrupting the tracked command', async () => {
  await withFreshPane(async (paneId) => {
    const result = await executeCommandWaitForContent(
      paneId,
      'printf "STARTED\\n"; sleep 10',
      'READY',
      { timeoutSeconds: 0.5, pollIntervalMs: 20 },
    );

    try {
      assert.equal(result.status, 'timed_out');
      assert.equal(result.commandStatus, 'pending');
      assert.match(result.output, /STARTED/);
      assert.equal(typeof result.commandId, 'string');
      assert.ok(result.commandId.length > 0);
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('does not match status diagnostics before command capture starts', async () => {
  await withFreshPane(async (paneId) => {
    await executeTmux(['send-keys', '-t', paneId, 'sleep 10', 'Enter']);
    await waitForCurrentCommand(paneId, 'sleep');

    const result = await executeCommandWaitForContent(
      paneId,
      ':',
      'captured properly',
      { timeoutSeconds: 0.1, pollIntervalMs: 20 },
    );

    try {
      assert.equal(result.status, 'timed_out');
      assert.equal(result.commandStatus, 'pending');
      assert.equal(result.output, '');
    } finally {
      await sendInterrupt(paneId);
    }
  });
});

test('retains genuine output when the start marker leaves the capture window', async () => {
  await withFreshPane(async (paneId) => {
    const releaseChannel = `tmux-mcp-flood-${randomUUID()}`;
    let released = false;
    let genuineOutputTicks = 0;
    const progress = {
      hasToken: () => true,
      tickIfDue: async () => {
        const content = await executeTmux(['capture-pane', '-p', '-t', paneId]);
        const sawGenuineOutput = content
          .split('\n')
          .some(line => line.trim() === 'GENUINE_OUTPUT');
        if (sawGenuineOutput) genuineOutputTicks += 1;
        if (genuineOutputTicks >= 2 && !released) {
          released = true;
          await executeTmux(['wait-for', '-S', releaseChannel]);
        }
      },
    };

    const waiting = executeCommandWaitForContent(
      paneId,
      `printf "GENUINE_OUTPUT\\n"; tmux wait-for ${releaseChannel}; ` +
        'yes FILLER | head -n 3500; sleep 10',
      'captured properly',
      { timeoutSeconds: 1, pollIntervalMs: 20, progress },
    );

    try {
      const result = await waiting;
      assert.equal(result.status, 'timed_out');
      assert.equal(result.commandStatus, 'pending');
      assert.match(result.output, /GENUINE_OUTPUT/);
      assert.doesNotMatch(result.output, /captured properly/);
    } finally {
      await executeTmux(['wait-for', '-S', releaseChannel]);
      await sendInterrupt(paneId);
    }
  });
});

test('does not emit progress when pane content already satisfies appear wait', async () => {
  await withFreshPane(async (paneId) => {
    await executeTmux(['send-keys', '-t', paneId, 'printf "READY_NOW\\n"', 'Enter']);
    await waitForPaneText(paneId, 'READY_NOW');
    let ticks = 0;

    const result = await waitForPaneContent(paneId, 'READY_NOW', {
      timeoutSeconds: 1,
      ignoreExisting: false,
      progress: {
        hasToken: () => true,
        tickIfDue: async () => { ticks += 1; },
      },
    });

    assert.equal(result.found, true);
    assert.equal(ticks, 0);
  });
});

test('does not emit progress when pane content already satisfies gone wait', async () => {
  await withFreshPane(async (paneId) => {
    let ticks = 0;

    const result = await waitForPaneContentGone(paneId, 'NOT_PRESENT', {
      timeoutSeconds: 1,
      ignoreExisting: false,
      progress: {
        hasToken: () => true,
        tickIfDue: async () => { ticks += 1; },
      },
    });

    assert.deepEqual(result, { gone: true });
    assert.equal(ticks, 0);
  });
});

test('rejects an invalid regex before executing the command', async () => {
  await withFreshPane(async (paneId) => {
    await assert.rejects(
      executeCommandWaitForContent(
        paneId,
        'printf "SHOULD_NOT_RUN\\n"',
        '[invalid',
        { regex: true, timeoutSeconds: 1, pollIntervalMs: 100 },
      ),
      /Invalid regex/,
    );

    const paneContent = await executeTmux(['capture-pane', '-p', '-t', paneId]);
    assert.doesNotMatch(paneContent, /SHOULD_NOT_RUN/);
  });
});

test('rejects an empty pattern before executing the command', async () => {
  await withFreshPane(async (paneId) => {
    await assert.rejects(
      executeCommandWaitForContent(
        paneId,
        'printf "SHOULD_NOT_RUN_EMPTY_PATTERN\\n"',
        '',
        { timeoutSeconds: 1, pollIntervalMs: 100 },
      ),
      /pattern must not be empty/,
    );

    const paneContent = await executeTmux(['capture-pane', '-p', '-t', paneId]);
    assert.doesNotMatch(paneContent, /SHOULD_NOT_RUN_EMPTY_PATTERN/);
  });
});

test('rejects non-positive and non-finite timeouts before executing the command', async () => {
  await withFreshPane(async (paneId) => {
    for (const [label, timeoutSeconds] of [
      ['ZERO', 0],
      ['INFINITY', Infinity],
      ['NAN', NaN],
    ]) {
      const commandText = `SHOULD_NOT_RUN_${label}`;
      await assert.rejects(
        executeCommandWaitForContent(
          paneId,
          `printf "${commandText}\\n"`,
          'READY',
          { timeoutSeconds, pollIntervalMs: 100 },
        ),
        /timeoutSeconds/,
      );

      const paneContent = await executeTmux(['capture-pane', '-p', '-t', paneId]);
      assert.doesNotMatch(paneContent, new RegExp(commandText));
    }
  });
});

test('rejects non-positive and non-finite poll intervals before executing the command', async () => {
  await withFreshPane(async (paneId) => {
    for (const [label, pollIntervalMs] of [
      ['ZERO', 0],
      ['NEGATIVE', -1],
      ['NAN', NaN],
      ['INFINITY', Infinity],
    ]) {
      const commandText = `SHOULD_NOT_RUN_POLL_${label}`;
      await assert.rejects(
        executeCommandWaitForContent(
          paneId,
          `printf "${commandText}\\n"`,
          'READY',
          { timeoutSeconds: 1, pollIntervalMs },
        ),
        /pollIntervalMs/,
      );

      const paneContent = await executeTmux(['capture-pane', '-p', '-t', paneId]);
      assert.doesNotMatch(paneContent, new RegExp(commandText));
    }
  });
});
