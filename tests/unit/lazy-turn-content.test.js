/**
 * @fileoverview Tests that a turn's content can be built when the turn
 * starts rather than when it's queued (server/services/
 * agentProcessManager.js's TurnContent), against a fake `claude`
 * (fixtures/fake-claude.js) that takes a while to answer.
 *
 * Regression for a live spiral: a busy agent's queued turns each carried a
 * prompt built at queue time, so every one of them re-sent the same
 * catch-up, and the agent answered each as a "stale replay".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = mkdtempSync(join(tmpdir(), 'agentwaggle-lazy-'));
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '200';
process.env.APP_LOG_DIR = logDir;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/services/agentProcessManager.js')} */
let manager;

const text = (value) => [{ type: 'text', text: value }];
const noop = { onChunk: () => {} };

describe('runTurn — content built when the turn starts', () => {
  before(async () => {
    manager = await import('../../server/services/agentProcessManager.js');
  });

  after(async () => {
    await manager.killAll();
    rmSync(logDir, { recursive: true, force: true });
  });

  test('a queued turn builds its content only after the turn ahead of it has finished', async () => {
    const agent = { id: 'lazy-queue', name: 'Lazy', workingDir: tmpdir() };
    let firstDone = false;
    let firstDoneWhenBuilt;

    const first = manager.runTurn(agent, text('first'), noop).then((r) => { firstDone = true; return r; });
    const second = manager.runTurn(agent, () => {
      firstDoneWhenBuilt = firstDone;
      return text('second');
    }, noop);

    await Promise.all([first, second]);
    assert.equal(firstDoneWhenBuilt, true);
  });

  test('a builder that throws rejects its own turn, and the next turn still runs', async () => {
    const agent = { id: 'lazy-throw', name: 'Thrower', workingDir: tmpdir() };
    await assert.rejects(manager.runTurn(agent, () => { throw new Error('cannot build'); }, noop), /cannot build/);
    const next = await manager.runTurn(agent, text('after'), noop);
    assert.ok(next.text);
  });
});
