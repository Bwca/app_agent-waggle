/**
 * @fileoverview Tests what "@Agent /clear" and "@Agent /compact" leave in
 * the chat (server/ws/handler.js's runAgentsParallel), driving
 * handleUserMessage against an in-memory database and a fake `claude`
 * (fixtures/fake-claude.js) that answers both the way CLI 2.1.301 does.
 *
 * Regressions for two live reports: a "/clear" left a blank reply instead
 * of a system note (the CLI's reset event had changed shape), and a
 * "/compact" left a blank reply beside its 🗜️ note. Both notes also didn't
 * say whose context it was, and a system note shows no author.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'clauhort-clear-compact-'));
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.APP_DB_FILE = ':memory:';
process.env.APP_LOG_DIR = root;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/store/db.js')} */
let db;
/** @type {typeof import('../../server/ws/handler.js')} */
let handler;
/** @type {typeof import('../../server/services/agentProcessManager.js')} */
let manager;
const wss = { clients: [] };

async function setUpChat(name) {
  const dir = join(root, name);
  mkdirSync(dir);
  const agent = await db.createAgent({ id: `${name}-ada`, name: 'Ada', color: '#fff', workingDir: dir, dangerouslySkipPermissions: true });
  const chat = await db.createChat({ id: name, name, memberAgentIds: [agent.id] });
  return { chat, agent };
}

/** Ada's messages in the chat, oldest first. */
const adaMessages = (chatId, agentId) => db.getMessages(chatId, 50).filter((m) => m.agentId === agentId);

describe('local commands leave a named system note, never a blank reply', () => {
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

  test('"/clear" posts a system note naming the agent, and rotates its session', async () => {
    const { chat, agent } = await setUpChat('clear');
    await handler.handleUserMessage({ chatId: chat.id, content: '@Ada hello' }, wss);
    await handler.handleUserMessage({ chatId: chat.id, content: '@Ada /clear' }, wss);

    const last = adaMessages(chat.id, agent.id).at(-1);
    assert.equal(last.isSystemNote, true);
    assert.match(last.content, /Ada's context was cleared/);
    assert.ok(db.getAgent(agent.id).contextResetAt, 'the clear must be recorded, so the next turn re-introduces the agent');
    assert.match(db.getAgent(agent.id).resumeId, /^cleared-/);
  });

  test('"/compact" posts only its compaction note naming the agent, no blank reply', async () => {
    const { chat, agent } = await setUpChat('compact');
    const sent = [];
    const client = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    await handler.handleUserMessage({ chatId: chat.id, content: '@Ada /compact' }, { clients: [client] });

    // The browser hears about the compaction while it runs, not only after.
    const statuses = sent.filter((e) => e.type === 'AGENT_STREAM_STATUS').map((e) => e.status);
    assert.deepEqual(statuses, ['🗜️ Compacting context…', '🗜️ Context compacted, continuing…']);

    const messages = adaMessages(chat.id, agent.id);
    assert.equal(messages.length, 1, `expected just the compaction note, got: ${JSON.stringify(messages.map((m) => m.content))}`);
    assert.equal(messages[0].isSystemNote, true);
    assert.equal(messages[0].content, "🗜️ Ada's context was compacted (manual): 19,249 → 1,840 tokens");
  });
});
