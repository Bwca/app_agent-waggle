/**
 * @fileoverview Tests the system notes recording an agent being added to
 * or removed from a chat (server/ws/handler.js's postAgentAddedNote and
 * postAgentRemovedNote), against an in-memory database.
 *
 * Names aren't unique, so a note naming only "Ada" can't say which Ada:
 * each note includes the agent's id too.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'agentwaggle-roster-notes-'));
process.env.APP_DB_FILE = ':memory:';
process.env.APP_LOG_DIR = root;
process.env.APP_LOG_LEVEL = 'silent';

/** @type {typeof import('../../server/store/db.js')} */
let db;
/** @type {typeof import('../../server/ws/handler.js')} */
let handler;
const wss = { clients: [] };

describe('roster-change notes', () => {
  before(async () => {
    db = await import('../../server/store/db.js');
    await db.loadDb();
    handler = await import('../../server/ws/handler.js');
  });

  test('tell two agents with the same name apart by id', async () => {
    const first = await db.createAgent({ id: 'ada-1', name: 'Ada', color: '#fff', workingDir: root });
    const second = await db.createAgent({ id: 'ada-2', name: 'Ada', color: '#fff', workingDir: root });
    const chat = await db.createChat({ id: 'notes', name: 'notes', memberAgentIds: [] });

    await handler.postAgentAddedNote(chat, first, 'user', wss);
    await handler.postAgentAddedNote(chat, second, 'mcp', wss);
    await handler.postAgentRemovedNote(chat, first, 'user', wss);

    assert.deepEqual(db.getMessages(chat.id, 10).map((m) => m.content), [
      '➕ The user added Ada [agent ada-1] to the chat',
      '➕ An MCP client added Ada [agent ada-2] to the chat',
      '🚪 The user removed Ada [agent ada-1] from the chat',
    ]);
  });

  test('name the agent that acted, when one did', async () => {
    const ada = await db.createAgent({ id: 'ada-3', name: 'Ada', color: '#fff', workingDir: root });
    const clarke = await db.createAgent({ id: 'clarke', name: 'Clarke', color: '#fff', workingDir: root });
    const chat = await db.createChat({ id: 'by-agent', name: 'by-agent', memberAgentIds: [] });

    await handler.postAgentAddedNote(chat, ada, clarke, wss);
    await handler.postAgentRemovedNote(chat, ada, clarke, wss);

    assert.deepEqual(db.getMessages(chat.id, 10).map((m) => m.content), [
      '➕ Clarke [agent clarke] added Ada [agent ada-3] to the chat',
      '🚪 Clarke [agent clarke] removed Ada [agent ada-3] from the chat',
    ]);
  });
});
