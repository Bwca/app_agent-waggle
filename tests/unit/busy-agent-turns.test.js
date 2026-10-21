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

const root = mkdtempSync(join(tmpdir(), 'agentwaggle-busy-'));
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

  /**
   * Bea answers "@Ada please look at …" at once, but her chain relays it
   * only when slow Cid answers too. Ada is asked something directly in
   * between, so she reads Bea's mention as catch-up before the relay comes.
   * Each agent's process is spawned here, one at a time, so it keeps the
   * reply and delay the env had then.
   */
  async function setUpLateRelay(name, adaDelayMs) {
    await manager.killAll();
    const { chat, dirs: [ada] } = await setUpChat(name, ['Ada', 'Bea', 'Cid']);
    const send = (content) => handler.handleUserMessage({ chatId: chat.id, content }, wss);
    const spawn = async (agentName, delayMs, reply) => {
      process.env.FAKE_CLAUDE_REPLY_DELAY_MS = String(delayMs);
      process.env.FAKE_CLAUDE_REPLY = reply;
      await send(`@${agentName} warm up`);
    };
    await spawn('Ada', adaDelayMs, 'ok {turn}');
    await spawn('Cid', 600, 'done {turn}');
    await spawn('Bea', 0, '@Ada please look at {turn}');
    process.env.FAKE_CLAUDE_REPLY_DELAY_MS = '400';
    delete process.env.FAKE_CLAUDE_REPLY;
    const beaReplied = () => db.getMessages(chat.id, 50).filter((m) => m.agentId === `${name}-Bea`).at(-1);
    const warmedUp = promptsOf(ada).length;
    const warmUpReply = beaReplied().id;
    const chain = send('@Bea @Cid go');
    await until(() => beaReplied().id !== warmUpReply);
    return { chat, ada, send, chain, warmedUp, beaReply: beaReplied().content };
  }

  test('a relay of a mention the agent already read in a finished turn starts no turn', async () => {
    const { ada, send, chain, warmedUp, beaReply } = await setUpLateRelay('late-done', 0);
    await send('@Ada hello');
    assert.equal(timesSeen(promptsOf(ada).slice(warmedUp), beaReply), 1, 'Ada should have read Bea\'s mention as catch-up');
    await chain;

    assert.equal(promptsOf(ada).length - warmedUp, 1, 'the late relay of a mention Ada already read should not start another turn');
  });

  test('a relay of a mention the agent is reading in a running turn shares that turn\'s reply', async () => {
    const { chat, ada, send, chain, warmedUp, beaReply } = await setUpLateRelay('late-running', 1000);
    const direct = send('@Ada hello');
    await until(() => promptsOf(ada).length > warmedUp);
    await Promise.all([direct, chain]);

    const prompts = promptsOf(ada).slice(warmedUp);
    assert.equal(prompts.length, 1, 'the late relay should join Ada\'s running turn, not queue another');
    assert.equal(timesSeen(prompts, beaReply), 1);
    assert.equal(db.getMessages(chat.id, 50).filter((m) => m.agentId === 'late-running-Ada').length - warmedUp, 1, 'Ada should post one reply');
  });
});
