/**
 * @fileoverview Tests promptHistoryFor (server/ws/handler.js), the history a
 * turn's prompt is built from, against an in-memory database.
 *
 * Reported live: an agent whose only reply had scrolled 21 messages back
 * was taken for a newcomer, got the full "You are being added to a chat"
 * preamble again, and concluded it had been re-added to a new lineup.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'agentwaggle-prompt-history-'));
process.env.APP_DB_FILE = ':memory:';
process.env.APP_LOG_DIR = root;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/store/db.js')} */
let db;
/** @type {typeof import('../../server/ws/handler.js')} */
let handler;

/** Saves a message `seconds` after a fixed start, so the order is certain. */
async function say(chatId, agentId, content, seconds, extra = {}) {
  await db.addMessage({
    id: `${chatId}-${seconds}`,
    chatId,
    role: agentId ? 'agent' : 'user',
    agentId,
    authorName: agentId ?? 'You',
    content,
    attachments: [],
    toolCalls: [],
    createdAt: new Date(Date.UTC(2026, 9, 21, 20, 0, seconds)).toISOString(),
    ...extra,
  });
}

describe('promptHistoryFor', () => {
  before(async () => {
    db = await import('../../server/store/db.js');
    await db.loadDb();
    handler = await import('../../server/ws/handler.js');
  });

  test('keeps an agent\'s last turn that scrolled out of the window, so it isn\'t introduced again', async () => {
    const opaline = await db.createAgent({ id: 'opaline', name: 'Opaline', color: '#fff', workingDir: root });
    const chat = await db.createChat({ id: 'quiet', name: 'quiet', memberAgentIds: ['opaline'] });
    await say(chat.id, null, '@Opaline hi', 0);
    await say(chat.id, 'opaline', 'hello', 1);
    for (let i = 0; i < 20; i++) await say(chat.id, null, `message ${i}`, 2 + i);

    const { recent, priorMessages } = handler.promptHistoryFor(chat.id, opaline);
    assert.equal(recent.length, 20);
    assert.ok(!recent.some((m) => m.agentId === 'opaline'), 'the reply is past the window');
    assert.equal(priorMessages[0].content, 'hello');

    const agent = { ...opaline, resumeId: 'ses-1' };
    const blocks = handler.buildPromptBlocks(agent, chat, [agent], { content: '@Opaline still there?' }, priorMessages);
    assert.ok(!blocks[0].text.includes('[System]'), 'no second introduction');
    assert.ok(blocks[0].text.startsWith('[Current chat roster]'));
  });

  test('adds nothing when the last turn is already in the window, or there is none', async () => {
    const clarke = await db.createAgent({ id: 'clarke', name: 'Clarke', color: '#fff', workingDir: root });
    const chat = await db.createChat({ id: 'busy', name: 'busy', memberAgentIds: ['clarke'] });
    await say(chat.id, null, 'hi', 0);
    assert.equal(handler.promptHistoryFor(chat.id, clarke).priorMessages.length, 1);

    await say(chat.id, 'clarke', 'hello', 1);
    await say(chat.id, 'clarke', '🗜️ Clarke\'s context was compacted (auto): size unreported', 2, { authorName: 'Clarke', isSystemNote: true });
    const { recent, priorMessages } = handler.promptHistoryFor(chat.id, clarke);
    assert.deepEqual(priorMessages, recent);
  });
});
