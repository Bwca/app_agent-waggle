/**
 * @fileoverview Tests that a process being killed takes no new turns
 * (server/services/agentProcessManager.js's isAvailable/killAgent), against
 * a fake `claude` (fixtures/fake-claude.js) instead of the real CLI.
 *
 * Regression for a failing E2E test (10-agent-exclusivity, "re-adding an
 * agent to a different chat starts a genuinely fresh session"): removing an
 * agent from a chat kills its process without waiting for it to exit, and
 * the agent's first turn in its next chat was written to that still-exiting
 * process — spawned with the old chat's --resume — which then died
 * mid-turn with "exited with code 143".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = mkdtempSync(join(tmpdir(), 'clauhort-retire-'));
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.APP_LOG_DIR = logDir;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/services/agentProcessManager.js')} */
let manager;

const text = (value) => [{ type: 'text', text: value }];
const noop = { onChunk: () => {} };

describe('killAgent — a retiring process takes no new turns', () => {
  before(async () => {
    manager = await import('../../server/services/agentProcessManager.js');
  });

  after(async () => {
    await manager.killAll();
    rmSync(logDir, { recursive: true, force: true });
  });

  test('a turn sent right after an un-awaited kill runs on a fresh process with the new session', async () => {
    const agent = { id: 'retire-move', name: 'Mover', workingDir: tmpdir(), resumeId: 'chat-a-session' };
    const first = await manager.runTurn(agent, text('hi'), noop);
    assert.equal(first.sessionId, 'chat-a-session');

    // What leaving chat A does: kill without waiting, and forget the session.
    manager.killAgent(agent.id).catch(() => {});
    const moved = { ...agent, resumeId: undefined };

    const second = await manager.runTurn(moved, text('hi again'), noop);
    assert.notEqual(second.text, first.text, 'the second turn must not run on the process being killed');
    assert.equal(second.sessionId, 'fresh', 'the second turn must not resume the old chat\'s session');
  });

  test('killing twice returns the same pending exit', async () => {
    const agent = { id: 'retire-twice', name: 'Twice', workingDir: tmpdir() };
    await manager.runTurn(agent, text('hi'), noop);
    const a = manager.killAgent(agent.id);
    const b = manager.killAgent(agent.id);
    assert.equal(a, b);
    await a;
  });
});
