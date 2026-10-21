/**
 * @fileoverview Tests that "Grant all" retries with every row's grant in
 * place (server/ws/handler.js's withPermissionLock), feeding the real WS
 * handler two GRANT_PERMISSION messages in one tick — what the client's
 * "Grant all" button sends — against an in-memory database and a fake
 * `claude` (fixtures/fake-claude.js) that records its arguments.
 *
 * Regression for a flaky E2E test: a chained Bash grant had saved its
 * `git init` pattern but not yet its `git add` one when the last row's
 * retry spawned the agent's process, so the retry was denied again.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'agentwaggle-grant-'));
const argsDir = join(root, 'args');
mkdirSync(argsDir);
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.FAKE_CLAUDE_ARGS_DIR = argsDir;
process.env.APP_DB_FILE = ':memory:';
process.env.APP_LOG_DIR = root;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/store/db.js')} */
let db;
/** @type {typeof import('../../server/ws/handler.js')} */
let handler;
/** @type {typeof import('../../server/services/agentProcessManager.js')} */
let manager;

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('"Grant all" — the retry runs with every row granted', () => {
  before(async () => {
    db = await import('../../server/store/db.js');
    await db.loadDb();
    handler = await import('../../server/ws/handler.js');
    manager = await import('../../server/services/agentProcessManager.js');
  });

  after(async () => {
    await manager.killAll();
    rmSync(root, { recursive: true, force: true });
  });

  test('a chained Bash grant is fully applied before the last row\'s retry spawns the process', async () => {
    const workingDir = join(root, 'ada');
    mkdirSync(workingDir);
    const agent = await db.createAgent({ id: 'grant-ada', name: 'Ada', color: '#fff', workingDir });
    const chat = await db.createChat({ id: 'grant-chat', name: 'Grant', memberAgentIds: [agent.id] });

    const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {} });
    handler.handleConnection(ws, {}, { clients: [] });

    const outcomes = [
      { toolName: 'Bash', value: 'git init -q && git add -A', granted: true },
      { toolName: 'Write', value: join(root, 'outside', 'notes.txt'), granted: true },
    ];
    // What "Grant all" sends: every row in the same tick, the last one
    // carrying the auto-continue.
    ws.emit('message', JSON.stringify({ type: 'GRANT_PERMISSION', agentId: agent.id, chatId: chat.id, ...outcomes[0], autoContinue: false }));
    ws.emit('message', JSON.stringify({ type: 'GRANT_PERMISSION', agentId: agent.id, chatId: chat.id, ...outcomes[1], autoContinue: true, outcomes }));

    await until(() => readdirSync(argsDir).length > 0);
    const [argsFile] = readdirSync(argsDir);
    const args = JSON.parse(readFileSync(join(argsDir, argsFile), 'utf-8'));
    const allowedTools = args[args.indexOf('--allowedTools') + 1] ?? '';
    assert.ok(allowedTools.includes('Bash(git init:*)'), `missing git init in ${JSON.stringify(args)}`);
    assert.ok(allowedTools.includes('Bash(git add:*)'), `missing git add in ${JSON.stringify(args)}`);
    assert.ok(args.includes(join(root, 'outside')), `missing the Write row's directory in ${JSON.stringify(args)}`);
  });
});
