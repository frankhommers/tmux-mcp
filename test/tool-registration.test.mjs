import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executeTmux } from '../build/tmux.js';

function resultText(result) {
  assert.equal(result.content[0]?.type, 'text');
  return result.content[0].text;
}

test('discovers execute-command-wait-for-content with focused guidance and schema', async () => {
  const client = new Client({ name: 'tool-registration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--client-timeout-seconds=3'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    const asyncIndex = names.indexOf('execute-command-async');
    const waitIndex = names.indexOf('execute-command-wait-for-content');
    const killIndex = names.indexOf('execute-command-kill-after');

    assert.equal(waitIndex, asyncIndex + 1);
    assert.equal(killIndex, waitIndex + 1);

    const tool = tools[waitIndex];
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      'paneId',
      'command',
      'text',
      'regex',
      'timeoutSeconds',
      'pollIntervalMs',
      'suppressHistory',
    ].sort());
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [
      'paneId',
      'command',
      'text',
      'timeoutSeconds',
    ].sort());
    assert.equal(tool.inputSchema.properties?.text?.minLength, 1);
    assert.match(tool.description ?? '', /atomically starts a tracked command/i);
    assert.match(tool.description ?? '', /only its own marker-delimited output/i);
    assert.match(tool.description ?? '', /timeout never interrupts/i);
    assert.match(tool.description ?? '', /progressToken/);
    assert.match(tool.description ?? '', /commandStatus.*pending/i);
    assert.match(tool.description ?? '', /get-command-result/);

    const asyncTool = tools.find(candidate => candidate.name === 'execute-command-async');
    assert.match(asyncTool?.description ?? '', /execute-command-wait-for-content/);

    const paneWaitTool = tools.find(candidate => candidate.name === 'wait-for-pane-content');
    assert.match(paneWaitTool?.description ?? '', /external|untracked/i);
    assert.match(paneWaitTool?.description ?? '', /execute-command-wait-for-content/);
    assert.match(paneWaitTool?.description ?? '', /ORDERING\/RACE/);
    assert.match(paneWaitTool?.description ?? '', /ignoreExisting=true/);

    const sessionName = `tmux-mcp-tool-registration-${process.pid}-${randomUUID()}`;
    const paneId = await executeTmux([
      'new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_id}',
    ]);
    try {
      const matched = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "READY\\n"',
          text: 'READY',
          timeoutSeconds: 2,
          pollIntervalMs: 50,
        },
      });
      assert.equal(matched.isError, false);
      assert.match(resultText(matched), /^Status: matched$/m);
      assert.match(resultText(matched), /^Command status: completed$/m);
      assert.match(resultText(matched), /^Exit code: 0$/m);
      assert.match(resultText(matched), /^Command ID: .+$/m);
      assert.match(resultText(matched), /^Matched line: READY$/m);
      assert.match(resultText(matched), /--- Output ---\nREADY/);

      const exited = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "DONE\\n"',
          text: 'READY',
          timeoutSeconds: 2,
          pollIntervalMs: 50,
        },
      });
      assert.equal(exited.isError, true);
      assert.match(resultText(exited), /^Status: exited_without_match$/m);
      assert.match(resultText(exited), /^Command status: completed$/m);
      assert.doesNotMatch(resultText(exited), /^Matched line:/m);
      assert.match(resultText(exited), /--- Output ---\nDONE/);

      const emptyPattern = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "SHOULD_NOT_RUN_EMPTY_MCP_PATTERN\\n"',
          text: '',
          timeoutSeconds: 2,
        },
      });
      assert.equal(emptyPattern.isError, true);
      const afterEmptyPattern = await executeTmux(['capture-pane', '-p', '-t', paneId]);
      assert.doesNotMatch(afterEmptyPattern, /SHOULD_NOT_RUN_EMPTY_MCP_PATTERN/);

      const capped = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "SHOULD_NOT_RUN\\n"',
          text: 'READY',
          timeoutSeconds: 3,
        },
      });
      assert.equal(capped.isError, true);
      assert.match(resultText(capped), /exceeds the server's blocking-call cap/);
      const paneContent = await executeTmux(['capture-pane', '-p', '-t', paneId]);
      assert.doesNotMatch(paneContent, /SHOULD_NOT_RUN/);

      // The SDK adds request._meta.progressToken when onprogress is supplied.
      // Executing above the server cap proves the handler received that token.
      const overCapWithProgress = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "PROGRESS_TOKEN_READY\\n"',
          text: 'PROGRESS_TOKEN_READY',
          timeoutSeconds: 100,
          pollIntervalMs: 20,
        },
      }, undefined, {
        onprogress: () => {},
      });
      assert.equal(overCapWithProgress.isError, false);
      assert.match(resultText(overCapWithProgress), /^Status: matched$/m);
      assert.match(resultText(overCapWithProgress), /PROGRESS_TOKEN_READY/);

      const pendingMatch = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'printf "PENDING_READY\\n"; sleep 0.5',
          text: 'PENDING_READY',
          timeoutSeconds: 2,
          pollIntervalMs: 20,
        },
      });
      assert.equal(pendingMatch.isError, false);
      assert.match(resultText(pendingMatch), /^Command status: pending$/m);
      assert.match(resultText(pendingMatch), /poll.*Command ID.*get-command-result/i);

      await new Promise(resolve => setTimeout(resolve, 600));

      const timedOut = await client.callTool({
        name: 'execute-command-wait-for-content',
        arguments: {
          paneId,
          command: 'sleep 10',
          text: 'READY',
          timeoutSeconds: 0.1,
          pollIntervalMs: 20,
        },
      });
      assert.equal(timedOut.isError, true);
      assert.match(resultText(timedOut), /^Status: timed_out$/m);
      assert.match(resultText(timedOut), /^Command status: pending$/m);
      assert.match(resultText(timedOut), /NOTE: Timed out; no interrupt occurred\. The command is still running in the pane\./);
    } finally {
      await executeTmux(['kill-session', '-t', sessionName]);
    }
  } finally {
    await transport.close();
  }
});

test('human-assigned mode registers request-pane and drops creation tools', async () => {
  const client = new Client({ name: 'human-assigned-registration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js', '--human-assigned'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);

    assert.ok(names.includes('request-pane'));
    assert.ok(!names.includes('create-session'));
    assert.ok(!names.includes('create-window'));
    assert.ok(!names.includes('move-window'));

    const requestTool = tools.find(tool => tool.name === 'request-pane');
    assert.deepEqual(Object.keys(requestTool.inputSchema.properties ?? {}).sort(), [
      'reason', 'kind', 'timeoutSeconds', 'requestId',
    ].sort());
    assert.deepEqual([...(requestTool.inputSchema.required ?? [])], ['reason']);
    assert.match(requestTool.description ?? '', /start with access to nothing/i);
  } finally {
    await transport.close();
  }
});

test('without the flag request-pane is not registered', async () => {
  const client = new Client({ name: 'default-registration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(!tools.map(tool => tool.name).includes('request-pane'));
  } finally {
    await transport.close();
  }
});
