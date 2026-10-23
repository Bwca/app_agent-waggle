/**
 * @fileoverview Tests that stopping a turn (runTurn's `signal`, what the
 * Stop button aborts) resolves it as stopped rather than failing it, in
 * server/services/agentProcessManager.js, against a fake `claude`
 * (fixtures/fake-claude.js) instead of the real CLI.
 *
 * Regression: a stop before the agent had replied showed up as an error.
 * The real CLI answers the interrupt with an is_error result ("Claude
 * reported an error: [ede_diagnostic] …"), and a CLI that just dies on it
 * exits non-zero ("opencode process exited with code 1").
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = mkdtempSync(join(tmpdir(), 'agentwaggle-stop-'));
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.APP_LOG_DIR = logDir;
process.env.APP_LOG_LEVEL = 'silent';
process.env.APP_DB_FILE = ':memory:';

/** @type {typeof import('../../server/services/agentProcessManager.js')} */
let manager;

const text = (value) => [{ type: 'text', text: value }];

/** Starts a slow turn and stops it before the reply arrives. */
async function stopMidTurn(agentId) {
  const controller = new AbortController();
  const turn = manager.runTurn({ id: agentId, name: 'Stopper', workingDir: tmpdir() }, text('hi'), {
    onChunk: () => {},
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  return turn;
}

describe('runTurn — a stopped turn is not an error', () => {
  before(async () => {
    // Loaded for the user's locale, which turn error messages are worded in.
    await (await import('../../server/store/db.js')).loadDb();
    manager = await import('../../server/services/agentProcessManager.js');
    process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '5000';
  });

  afterEach(() => {
    delete process.env.FAKE_CLAUDE_SIGINT_EXIT_CODE;
  });

  after(async () => {
    delete process.env.FAKE_CLAUDE_REPLY_DELAY_MS;
    await manager.killAll();
    rmSync(logDir, { recursive: true, force: true });
  });

  test('the CLI ending the stopped turn with an error result', async () => {
    const result = await stopMidTurn('stop-error-result');
    assert.equal(result.stopped, true);
    assert.equal(result.text, '');
  });

  test('the CLI exiting non-zero on the stop', async () => {
    process.env.FAKE_CLAUDE_SIGINT_EXIT_CODE = '1';
    const result = await stopMidTurn('stop-exit-code');
    assert.equal(result.stopped, true);
    assert.equal(result.text, '');
  });
});
