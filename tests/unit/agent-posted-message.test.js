/**
 * @fileoverview Tests handleUserMessage's asAgentId (server/ws/handler.js):
 * an agent posting into its own chat over MCP's send_message is saved as
 * that agent, not the user, and routed the way its reply would be relayed.
 * Drives handleUserMessage against an in-memory database and a fake
 * `claude` (fixtures/fake-claude.js).
 *
 * Regression for a live mix-up: an agent answered the user by posting
 * "@Teammate …" through send_message, which saved it as the user's own
 * message, so the chat showed the user saying it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'clauhort-agent-post-'));
const promptDir = join(root, 'prompts');
mkdirSync(promptDir);
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
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

/** Every prompt an agent received, as one string each. */
function promptsOf(agentId) {
  return readdirSync(promptDir)
    .filter((f) => f.startsWith(`${agentId}-`))
    .map((f) => JSON.parse(readFileSync(join(promptDir, f), 'utf-8')).message.content.map((b) => b.text ?? '').join('\n'));
}

async function setUpChat(name, agentNames) {
  const agents = [];
  for (const agentName of agentNames) {
    const dir = join(root, `${name}-${agentName}`);
    mkdirSync(dir);
    agents.push(await db.createAgent({ id: `${name}-${agentName}`, name: agentName, color: '#fff', workingDir: dir, dangerouslySkipPermissions: true }));
  }
  const chat = await db.createChat({ id: name, name, memberAgentIds: agents.map((a) => a.id) });
  return { chat, ids: agents.map((a) => a.id) };
}

describe('an agent posting into its own chat', () => {
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

  test('is saved as that agent and labelled with its id for the teammate it mentions', async () => {
    const { chat, ids: [ada, bea] } = await setUpChat('post', ['Ada', 'Bea']);
    const { userMessage } = await handler.handleUserMessage({ chatId: chat.id, content: '@Bea please check this', asAgentId: ada }, wss);

    assert.equal(userMessage.role, 'agent');
    assert.equal(userMessage.agentId, ada);
    assert.equal(userMessage.authorName, 'Ada');
    const [beaPrompt] = promptsOf(bea);
    assert.match(beaPrompt, new RegExp(`Ada \\[agent ${ada}\\]: @Bea please check this`));
    assert.equal(promptsOf(ada).length, 0, 'the author must not get a turn for its own post');
  });

  test('is not broadcast when it mentions no one', async () => {
    const { chat, ids: [ada, bea] } = await setUpChat('quiet', ['Ada', 'Bea']);
    const { replies } = await handler.handleUserMessage({ chatId: chat.id, content: 'a note for the record', asAgentId: ada }, wss);

    assert.equal(replies.length, 0);
    assert.equal(promptsOf(bea).length, 0);
  });

  test('is never relayed back to its author, who is still mid-turn waiting on it', async () => {
    process.env.FAKE_CLAUDE_REPLY = '@Ada done {turn}';
    const { chat, ids: [ada, bea] } = await setUpChat('back', ['Ada', 'Bea']);
    const { replies } = await handler.handleUserMessage({ chatId: chat.id, content: '@Bea please check this', asAgentId: ada }, wss);
    delete process.env.FAKE_CLAUDE_REPLY;

    assert.deepEqual(replies.map((m) => m.agentId), [bea]);
    assert.equal(promptsOf(ada).length, 0);
  });

  test('is refused for an agent that is not a member of the chat', async () => {
    const { chat } = await setUpChat('outside', ['Ada']);
    const { ids: [stranger] } = await setUpChat('elsewhere', ['Cy']);
    const { userMessage } = await handler.handleUserMessage({ chatId: chat.id, content: 'hello', asAgentId: stranger }, wss);

    assert.equal(userMessage, null);
    assert.equal(db.getMessages(chat.id, 10).length, 0);
  });
});
