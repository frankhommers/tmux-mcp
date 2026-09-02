import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { executeTmux, listAllPanes, listAllWindowIds } from '../build/tmux.js';

test('listAllPanes reports ids, names and current command', async () => {
  const sessionName = `tmux-mcp-inventory-${process.pid}-${randomUUID()}`;
  await executeTmux(['new-session', '-d', '-s', sessionName]);
  try {
    const panes = await listAllPanes();
    const mine = panes.filter(p => p.sessionName === sessionName);
    assert.equal(mine.length, 1);
    assert.match(mine[0].paneId, /^%\d+$/);
    assert.match(mine[0].windowId, /^@\d+$/);
    assert.match(mine[0].sessionId, /^\$\d+$/);
    assert.equal(mine[0].paneIndex, '0');
    assert.ok(mine[0].currentCommand.length > 0);

    const windowIds = await listAllWindowIds();
    assert.ok(windowIds.includes(mine[0].windowId));
  } finally {
    await executeTmux(['kill-session', '-t', sessionName]);
  }
});
