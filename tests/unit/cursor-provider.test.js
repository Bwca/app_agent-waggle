/**
 * @fileoverview Unit tests for the Cursor provider (server/services/
 * providers/cursor.js): the ACP handshake, turn accumulation, and answering
 * permission requests from the agent's stored grants. The messages are
 * shaped like ones recorded from a real `cursor-agent acp` (2026.10.19) run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cursorProvider, decidePermission, resolveModelValue, rpcErrorText } from '../../server/services/providers/cursor.js';

const AGENT = { id: 'a', name: 'Curtis', workingDir: '/work', provider: 'cursor' };

/** Model values as a real session lists them. */
const MODEL_VALUES = ['default[]', 'grok-4.7[context=256k,reasoning_effort=high,fast=true]', 'grok-4.6[effort=high,fast=true]', 'composer-2.5[fast=true]'];

/**
 * A provider state wired to a recorder, plus a way to feed it a message and
 * get back whatever normalizeEvent passes on.
 * @param {object} [agent]
 */
function connect(agent = AGENT) {
  const sent = [];
  const state = cursorProvider.createProcessState(agent, { write: (data) => sent.push(JSON.parse(data)) });
  const receive = (message) => cursorProvider.normalizeEvent(state, { jsonrpc: '2.0', ...message });
  return { state, sent, receive };
}

/** Lets a handshake step's awaited promise settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const update = (sessionUpdate, fields = {}) => ({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate, ...fields } } });

const modelConfig = (currentValue) => [{ id: 'model', currentValue, options: MODEL_VALUES.map((value) => ({ value })) }];

/**
 * Answers the handshake's initialize and authenticate requests.
 * @param {{ sent: object[], receive: (message: object) => object | null }} connection
 */
async function initAndAuth({ sent, receive }) {
  assert.equal(sent[0].method, 'initialize');
  receive({ id: sent[0].id, result: { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }] } });
  await tick();
  assert.equal(sent[1].method, 'authenticate');
  assert.deepEqual(sent[1].params, { methodId: 'cursor_login' });
  receive({ id: sent[1].id, result: {} });
  await tick();
}

describe('Cursor provider', () => {
  test('spawns `cursor-agent acp`', () => {
    const { args } = cursorProvider.spawnCommand(AGENT);
    assert.deepEqual(args, ['acp']);
  });

  test('lists its models through a session, not `cursor-agent models`', () => {
    const { command, args } = cursorProvider.modelsCommand(AGENT);
    assert.equal(command, process.execPath);
    assert.match(args[0], /cursorModels\.js$/);
  });

  test('handshakes and logs in on the first turn, then prompts the new session', async () => {
    const connection = connect();
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    await initAndAuth(connection);
    assert.equal(sent[2].method, 'session/new');
    assert.deepEqual(sent[2].params, { cwd: '/work', mcpServers: [] });
    receive({ id: sent[2].id, result: { sessionId: 's1', configOptions: modelConfig('default[]') } });
    await started;

    assert.equal(sent[3].method, 'session/prompt');
    assert.deepEqual(sent[3].params, { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] });
    assert.equal(state.model, 'default[]');
  });

  test('a failed login fails the turn, saying how to log in', async () => {
    const { state, sent, receive } = connect();
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    receive({ id: sent[0].id, result: {} });
    await tick();
    receive({ id: sent[1].id, error: { code: -32000, message: 'Authentication required' } });
    await assert.rejects(started, /cursor-agent login/);
  });

  test('resumes with session/load, dropping the history it replays', async () => {
    const connection = connect({ ...AGENT, resumeId: 's1' });
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'again' }]);
    await initAndAuth(connection);
    assert.equal(sent[2].method, 'session/load');
    assert.equal(sent[2].params.sessionId, 's1');

    assert.equal(receive(update('user_message_chunk', { content: { type: 'text', text: 'old question' } })), null);
    assert.equal(receive(update('tool_call', { toolCallId: 'replay-0-2', title: '`echo hello > out.txt`', kind: 'execute', status: 'pending' })), null);
    assert.equal(receive(update('agent_message_chunk', { content: { type: 'text', text: 'old answer' } })), null);

    receive({ id: sent[2].id, result: { configOptions: modelConfig('default[]') } });
    await started;
    assert.equal(sent[3].method, 'session/prompt');
    assert.ok(receive(update('agent_message_chunk', { content: { type: 'text', text: 'new' } })));
  });

  test('a session Cursor never saved is replaced by a new one', async () => {
    // Seen live: a session whose turns never reached a model isn't saved,
    // and loading it fails with this, under a generic "Invalid params".
    const connection = connect({ ...AGENT, resumeId: 'gone' });
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    await initAndAuth(connection);
    receive({ id: sent[2].id, error: { code: -32602, message: 'Invalid params', data: { message: 'Session "gone" not found' } } });
    await tick();
    assert.equal(sent[3].method, 'session/new');
    receive({ id: sent[3].id, result: { sessionId: 's2', configOptions: modelConfig('default[]') } });
    await started;
    assert.equal(sent[4].params.sessionId, 's2');
  });

  test('any other failed load fails the turn, and the next turn tries again', async () => {
    const connection = connect({ ...AGENT, resumeId: 's1' });
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    await initAndAuth(connection);
    receive({ id: sent[2].id, error: { code: -32603, message: 'Internal error', data: { details: 'disk full' } } });
    await assert.rejects(started, /disk full/);

    cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]).catch(() => {});
    assert.equal(sent.at(-1).method, 'initialize');
  });

  test('switches to the agent\'s model override, as the session lists it', async () => {
    const connection = connect({ ...AGENT, modelOverride: 'grok-4.6' });
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    await initAndAuth(connection);
    receive({ id: sent[2].id, result: { sessionId: 's1', configOptions: modelConfig('default[]') } });
    await tick();
    assert.equal(sent[3].method, 'session/set_config_option');
    assert.deepEqual(sent[3].params, { sessionId: 's1', configId: 'model', value: 'grok-4.6[effort=high,fast=true]' });
    receive({ id: sent[3].id, result: { configOptions: modelConfig('grok-4.6[effort=high,fast=true]') } });
    await started;
    assert.equal(state.model, 'grok-4.6[effort=high,fast=true]');
  });

  test('skips switching when the session already runs the override', async () => {
    const connection = connect({ ...AGENT, modelOverride: 'auto' });
    const { state, sent, receive } = connection;
    const started = cursorProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    await initAndAuth(connection);
    receive({ id: sent[2].id, result: { sessionId: 's1', configOptions: modelConfig('default[]') } });
    await started;
    assert.equal(sent[3].method, 'session/prompt');
  });

  test('accumulates text and tool calls into one turn', () => {
    const { state, receive } = connect();
    state.sessionId = 's1';
    state.model = 'default[]';
    state.promptId = 7;
    const chunks = [];
    const statuses = [];
    const turn = cursorProvider.createTurnAccumulator({ onChunk: (t) => chunks.push(t), onStatus: (s) => statuses.push(s) });
    const feed = (message) => {
      const event = receive(message);
      if (event) turn.handleEvent(event);
    };

    feed(update('agent_thought_chunk', { content: { type: 'text', text: 'Thinking.' } }));
    feed(update('tool_call', { toolCallId: 't1', title: '`echo hello > out.txt`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello > out.txt' } }));
    feed(update('tool_call_update', { toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 0, stdout: '', stderr: '' } }));
    feed(update('tool_call', { toolCallId: 't2', title: 'Read out.txt', kind: 'read', status: 'pending', rawInput: { path: '/work/out.txt' }, locations: [{ path: '/work/out.txt' }] }));
    feed(update('tool_call_update', { toolCallId: 't2', status: 'completed', rawOutput: { content: 'hello\n' } }));
    feed(update('agent_message_chunk', { content: { type: 'text', text: 'hel' } }));
    feed(update('agent_message_chunk', { content: { type: 'text', text: 'lo' } }));
    assert.equal(turn.done, false);
    feed({ id: 7, result: { stopReason: 'end_turn' } });

    assert.equal(turn.done, true);
    assert.equal(turn.fullText, 'hello');
    assert.deepEqual(chunks, ['hel', 'lo']);
    assert.deepEqual(statuses, ['Running: echo hello > out.txt', 'Reading out.txt']);
    assert.deepEqual([...turn.toolCalls.values()], [
      { id: 't1', name: 'Shell', label: 'Running: echo hello > out.txt', result: '', isError: false },
      { id: 't2', name: 'Read', label: 'Reading out.txt', result: 'hello\n', isError: false },
    ]);
    assert.equal(turn.sessionId, 's1');
    assert.equal(turn.model, 'default[]');
    assert.equal(turn.usage, null);
    assert.equal(turn.errorMessage, null);
  });

  test('a reply refusing the model for the plan ends the turn as an error', () => {
    // Seen live: Cursor sends this as the whole reply and ends the turn
    // normally, so without this it would be posted as the agent's answer.
    const { state, receive } = connect();
    state.promptId = 2;
    const turn = cursorProvider.createTurnAccumulator();
    turn.handleEvent(receive(update('agent_message_chunk', { content: { type: 'text', text: 'Upgrade your plan to continue' } })));
    turn.handleEvent(receive({ id: 2, result: { stopReason: 'end_turn' } }));
    assert.equal(turn.done, true);
    assert.match(turn.errorMessage, /Upgrade your plan to continue.*Auto/);
  });

  test('an error response to the prompt ends the turn with its most specific text', () => {
    const { state, receive } = connect();
    state.promptId = 3;
    const turn = cursorProvider.createTurnAccumulator();
    turn.handleEvent(receive({ id: 3, error: { code: -32603, message: 'Internal error', data: { details: 'Session s1 not found' } } }));
    assert.equal(turn.done, true);
    assert.equal(turn.errorMessage, 'Session s1 not found');
  });

  test('reports the commands its session offers as skills, and nothing as unsolicited turn content', () => {
    const signal = cursorProvider.inspectEvent(update('available_commands_update', { availableCommands: [{ name: 'simplify' }, { name: 'create-rule' }] }));
    assert.deepEqual(signal, { isTurnContent: false, skills: ['simplify', 'create-rule'] });
    assert.equal(cursorProvider.inspectEvent(update('agent_message_chunk', { content: { type: 'text', text: 'x' } })).isTurnContent, false);
  });

  test('drops Cursor\'s own notifications', () => {
    const { receive } = connect();
    assert.equal(receive({ method: 'cursor/update_todos', params: { todos: [] } }), null);
  });
});

describe('Cursor permission requests', () => {
  // Recorded: Cursor's first request to this client has id 0, and its tool
  // call has no rawInput; that was on the tool_call update before it.
  const ask = (toolCall) => ({
    id: 0,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });

  const requested = (toolCallId, command) => ({ toolCallId, title: `\`${command}\``, kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist' } }] });

  test('rejects an ungranted command and reports it as a denial', () => {
    const { sent, receive } = connect();
    receive(update('tool_call', { toolCallId: 't1', title: '`touch x`', kind: 'execute', status: 'pending', rawInput: { command: 'touch x' } }));
    const event = receive(ask(requested('t1', 'touch x')));

    assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
    assert.deepEqual(event, { type: 'permission_denied', denial: { tool_name: 'Shell', tool_use_id: 't1', tool_input: { command: 'touch x' } } });
  });

  test('a rejected call shows as denied, though Cursor reports it completed', () => {
    const { state, receive } = connect();
    state.promptId = 5;
    const turn = cursorProvider.createTurnAccumulator();
    const feed = (message) => {
      const event = receive(message);
      if (event) turn.handleEvent(event);
    };
    feed(update('tool_call', { toolCallId: 't1', title: '`touch x`', kind: 'execute', status: 'pending', rawInput: { command: 'touch x' } }));
    feed(ask(requested('t1', 'touch x')));
    feed(update('tool_call_update', { toolCallId: 't1', status: 'completed' }));
    feed(update('agent_message_chunk', { content: { type: 'text', text: 'The command was rejected.' } }));
    feed({ id: 5, result: { stopReason: 'end_turn' } });

    assert.equal(turn.errorMessage, null);
    assert.equal(turn.permissionDenials.length, 1);
    assert.deepEqual(turn.toolCalls.get('t1'), { id: 't1', name: 'Shell', label: 'Running: touch x', result: 'Permission denied', isError: true });
  });

  test('allows a command once every sub-command is granted, and consumes the request', () => {
    const agent = { ...AGENT, allowedToolPatterns: ['Shell(git add:*)', 'Shell(git commit:*)'] };
    const { sent, receive } = connect(agent);
    receive(update('tool_call', { toolCallId: 't2', title: '`git add -A && git commit -m x`', kind: 'execute', status: 'pending', rawInput: { command: 'git add -A && git commit -m x' } }));
    const event = receive(ask(requested('t2', 'git add -A && git commit -m x')));
    assert.equal(event, null);
    assert.equal(sent.at(-1).result.outcome.optionId, 'allow-once');
  });

  test('without a tool_call update first, the command comes from the request\'s title', () => {
    // Found live: answering from the request alone saw no command, so a
    // granted one was refused again, and the card would have offered to
    // grant the whole Shell tool.
    const agent = { ...AGENT, allowedToolPatterns: ['Shell(date:*)'] };
    const { receive } = connect(agent);
    assert.equal(receive(ask(requested('t3', 'date'))), null);
    const denied = connect().receive(ask(requested('t4', 'date')));
    assert.deepEqual(denied.denial.tool_input, { command: 'date' });
  });

  test('a file call\'s path comes from its tool_call update', () => {
    const { receive } = connect();
    receive(update('tool_call', { toolCallId: 't5', title: 'Edit hosts', kind: 'edit', status: 'pending', rawInput: { path: '/etc/hosts' } }));
    const event = receive(ask({ toolCallId: 't5', title: 'Edit hosts', kind: 'edit', status: 'pending' }));
    assert.deepEqual(event.denial, { tool_name: 'Edit', tool_use_id: 't5', tool_input: { file_path: '/etc/hosts' } });
  });

  test('grants follow the provider\'s own pattern syntax, which the decision reads back', () => {
    const { patterns } = cursorProvider.grantFor('Shell', 'npm test | tail -5');
    assert.deepEqual(patterns, ['Shell(npm test:*)', 'Shell(tail -5:*)']);
    const agent = { ...AGENT, allowedToolPatterns: patterns };
    assert.equal(decidePermission(agent, { tool_name: 'Shell', tool_input: { command: 'npm test | tail -5' } }), true);
    assert.equal(decidePermission(agent, { tool_name: 'Shell', tool_input: { command: 'npm publish' } }), false);
  });

  test('file tools are allowed inside the working directory and granted directories only', () => {
    const agent = { ...AGENT, extraAllowedPaths: ['/shared'] };
    const edit = (path) => ({ tool_name: 'Edit', tool_input: { file_path: path } });
    assert.equal(decidePermission(agent, edit('/work/src/a.js')), true);
    assert.equal(decidePermission(agent, edit('/shared/b.txt')), true);
    assert.equal(decidePermission(agent, edit('/workshop/c.txt')), false);
    assert.deepEqual(cursorProvider.grantFor('Edit', '/etc/hosts'), { path: '/etc' });
  });

  test('YOLO mode allows everything', () => {
    const agent = { ...AGENT, dangerouslySkipPermissions: true };
    assert.equal(decidePermission(agent, { tool_name: 'Shell', tool_input: { command: 'rm -rf build' } }), true);
  });

  test('refuses Cursor\'s blocking questions rather than leaving the turn waiting', () => {
    const { sent, receive } = connect();
    assert.equal(receive({ id: 9, method: 'cursor/ask_question', params: {} }), null);
    assert.equal(sent.at(-1).id, 9);
    assert.equal(sent.at(-1).error.code, -32601);
  });
});

describe('Cursor model values', () => {
  test('a bare model name picks the value the session lists for it', () => {
    assert.equal(resolveModelValue('grok-4.7', MODEL_VALUES), 'grok-4.7[context=256k,reasoning_effort=high,fast=true]');
  });

  test('an exact listed value is used as is, and "auto" is Cursor\'s Auto', () => {
    assert.equal(resolveModelValue('composer-2.5[fast=true]', MODEL_VALUES), 'composer-2.5[fast=true]');
    assert.equal(resolveModelValue('auto', MODEL_VALUES), 'default[]');
  });

  test('an unknown model is passed on for Cursor to reject', () => {
    assert.equal(resolveModelValue('cursor-grok-4.6-medium', MODEL_VALUES), 'cursor-grok-4.6-medium');
  });

  test('an error\'s detail wins over its generic message', () => {
    assert.equal(rpcErrorText({ message: 'Invalid params', data: { message: 'Invalid model value: x' } }), 'Invalid model value: x');
    assert.equal(rpcErrorText({ message: 'Method not found' }), 'Method not found');
  });
});

describe('finding the cursor-agent binary', () => {
  test('CURSOR_AGENT_BIN wins, then PATH', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { locateBin } = await import('../../server/services/providers/cursor.js');
    const root = mkdtempSync(join(tmpdir(), 'cursor-bin-'));
    const saved = { bin: process.env.CURSOR_AGENT_BIN, path: process.env.PATH };
    try {
      writeFileSync(join(root, 'cursor-agent'), '');
      process.env.CURSOR_AGENT_BIN = '/custom/cursor-agent';
      process.env.PATH = root;
      assert.deepEqual(locateBin(), { command: '/custom/cursor-agent', source: 'env' });
      delete process.env.CURSOR_AGENT_BIN;
      assert.deepEqual(locateBin(), { command: join(root, 'cursor-agent'), source: 'path' });
    } finally {
      if (saved.bin === undefined) delete process.env.CURSOR_AGENT_BIN;
      else process.env.CURSOR_AGENT_BIN = saved.bin;
      process.env.PATH = saved.path;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
