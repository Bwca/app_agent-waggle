/**
 * @fileoverview Tests that a busy agent sees each chat message exactly once
 * (server/ws/handler.js's runAgentsParallel: prompts built when a turn
 * starts, seenUntil, pendingTurns, one relay per reply), driving
 * handleUserMessage against an in-memory database and a fake `claude`
 * (fixtures/fake-claude.js) that takes a while to answer.
 *
 * Regression for a live spiral: an agent in a nine-minute turn had six
 * more turns queue up behind it, each carrying the same catch-up, and
 * answered every one as a "stale replay" — replies that @mentioned
 * teammates and set off the same thing for them.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'clauhort-busy-'));
const promptDir = join(root, 'prompts');
mkdirSync(promptDir);
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '400';
process.env.FAKE_CLAUDE_PROMPT_DIR = promptDir;
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

/** Every prompt an agent received, as one string each, in turn order. */
function promptsOf(dirName) {
  return readdirSync(promptDir)
    .filter((f) => f.startsWith(`${dirName}-`))
    .sort((a, b) => Number(a.split('-').at(-1).split('.')[0]) - Number(b.split('-').at(-1).split('.')[0]))
    .map((f) => JSON.parse(readFileSync(join(promptDir, f), 'utf-8')).message.content.map((b) => b.text ?? '').join('\n'));
}

/** How many times `text` appears across all of an agent's prompts. */
function timesSeen(prompts, text) {
  return prompts.reduce((n, p) => n + p.split(text).length - 1, 0);
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function setUpChat(name, agentNames) {
  const agents = [];
  for (const agentName of agentNames) {
    const dir = join(root, `${name}-${agentName}`);
    mkdirSync(dir);
    agents.push(await db.createAgent({ id: `${name}-${agentName}`, name: agentName, color: '#fff', workingDir: dir, dangerouslySkipPermissions: true }));
  }
  const chat = await db.createChat({ id: name, name, memberAgentIds: agents.map((a) => a.id) });
  return { chat, dirs: agentNames.map((n) => `${name}-${n}`) };
}

describe('a busy agent sees each message exactly once', () => {
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

  test('messages sent while it works fold into one follow-up turn, each shown once', async () => {
    const { chat, dirs: [ada] } = await setUpChat('fold', ['Ada']);
    const send = (content) => handler.handleUserMessage({ chatId: chat.id, content }, wss);

    const first = send('@Ada first request');
    await until(() => promptsOf(ada).length === 1);
    await Promise.all([first, send('@Ada second request'), send('@Ada third request')]);

    const prompts = promptsOf(ada);
    assert.equal(prompts.length, 2, 'the two messages that arrived mid-turn should be answered in one turn, not two');
    for (const text of ['first request', 'second request', 'third request']) {
      assert.equal(timesSeen(prompts, text), 1, `"${text}" should reach Ada exactly once`);
    }
  });

  test('a reply shared by folded turns is relayed to a teammate once', async () => {
    await manager.killAll();
    process.env.FAKE_CLAUDE_REPLY = '@Bea please check reply {turn}';
    const { chat, dirs: [ada, bea] } = await setUpChat('relay', ['Ada', 'Bea']);
    const send = (content) => handler.handleUserMessage({ chatId: chat.id, content }, wss);

    const first = send('@Ada first request');
    await until(() => promptsOf(ada).length === 1);
    // Bea spawns only once she's first relayed to, so she answers instantly
    // and is idle, not busy, each time a reply is relayed to her.
    process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '0';
    await Promise.all([first, send('@Ada second request'), send('@Ada third request')]);
    process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '400';

    const adaReplies = db.getMessages(chat.id, 50).filter((m) => m.agentId === 'relay-Ada').map((m) => m.content);
    assert.equal(adaReplies.length, 2);
    const beaPrompts = promptsOf(bea);
    for (const reply of adaReplies) {
      assert.equal(timesSeen(beaPrompts, reply), 1, `"${reply}" should reach Bea exactly once`);
    }
    delete process.env.FAKE_CLAUDE_REPLY;
  });
});
