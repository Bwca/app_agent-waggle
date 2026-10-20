/**
 * @fileoverview Unit tests for the opencode provider (server/services/
 * providers/opencode.js): the ACP handshake, turn accumulation, and
 * answering permission requests from the agent's stored grants. The
 * messages are shaped like ones recorded from a real `opencode acp`
 * (1.19.3) run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeProvider, decidePermission } from '../../server/services/providers/opencode.js';
import { getProvider } from '../../server/services/providers/index.js';

const AGENT = { id: 'a', name: 'Opal', workingDir: '/work', provider: 'opencode' };

/**
 * A provider state wired to a recorder, plus a way to feed it a message and
 * get back whatever normalizeEvent passes on.
 * @param {object} [agent]
 */
function connect(agent = AGENT) {
  const sent = [];
  const state = opencodeProvider.createProcessState(agent, { write: (data) => sent.push(JSON.parse(data)) });
  const receive = (message) => opencodeProvider.normalizeEvent(state, { jsonrpc: '2.0', ...message });
  return { state, sent, receive };
}

/** Lets a handshake step's awaited promise settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const update = (sessionUpdate, fields = {}) => ({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate, ...fields } } });

describe('opencode provider', () => {
  test('is registered', () => {
    assert.equal(getProvider('opencode'), opencodeProvider);
  });

  test('spawns `opencode acp` in the agent\'s working directory', () => {
    const { args } = opencodeProvider.spawnCommand(AGENT);
    assert.deepEqual(args, ['acp', '--cwd', '/work']);
  });

  test('handshakes on the first turn, then prompts the new session', async () => {
    const { state, sent, receive } = connect();
    const started = opencodeProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);

    assert.equal(sent[0].method, 'initialize');
    assert.equal(receive({ id: sent[0].id, result: { protocolVersion: 1 } }), null);
    await tick();
    assert.equal(sent[1].method, 'session/new');
    assert.equal(sent[1].params.cwd, '/work');
    receive({ id: sent[1].id, result: { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'ollama/local-agent' }] } });
    await started;

    assert.equal(sent[2].method, 'session/prompt');
    assert.deepEqual(sent[2].params, { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] });
    assert.equal(state.model, 'ollama/local-agent');
  });

  test('a later turn on the same process skips the handshake', async () => {
    const { state, sent, receive } = connect({ ...AGENT, resumeId: 's1' });
    const first = opencodeProvider.startTurn(state, [{ type: 'text', text: 'one' }]);
    receive({ id: sent[0].id, result: {} });
    await tick();
    receive({ id: sent[1].id, result: {} });
    await first;
    receive({ id: sent[2].id, result: { stopReason: 'end_turn' } });

    await opencodeProvider.startTurn(state, [{ type: 'text', text: 'two' }]);
    assert.deepEqual(sent.slice(3).map((m) => m.method), ['session/prompt']);
  });

  test('resumes with session/load, dropping the history it replays', async () => {
    const { state, sent, receive } = connect({ ...AGENT, resumeId: 's1' });
    const started = opencodeProvider.startTurn(state, [{ type: 'text', text: 'again' }]);
    receive({ id: sent[0].id, result: {} });
    await tick();
    assert.equal(sent[1].method, 'session/load');
    assert.equal(sent[1].params.sessionId, 's1');

    assert.equal(receive(update('user_message_chunk', { content: { type: 'text', text: 'old question' } })), null);
    assert.equal(receive(update('agent_message_chunk', { content: { type: 'text', text: 'old answer' } })), null);
    assert.equal(receive(update('tool_call', { toolCallId: 't0', title: 'echo old', kind: 'execute', status: 'pending' })), null);
    // Not history: the commands list still gets through.
    assert.ok(receive(update('available_commands_update', { availableCommands: [{ name: 'review' }] })));

    receive({ id: sent[1].id, result: {} });
    await started;
    assert.equal(sent[2].method, 'session/prompt');
    assert.ok(receive(update('agent_message_chunk', { content: { type: 'text', text: 'new' } })));
  });

  test('switches to the agent\'s model override after opening the session', async () => {
    const { state, sent, receive } = connect({ ...AGENT, modelOverride: 'opencode/big-pickle' });
    const started = opencodeProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    receive({ id: sent[0].id, result: {} });
    await tick();
    receive({ id: sent[1].id, result: { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'ollama/local-agent' }] } });
    await tick();
    assert.equal(sent[2].method, 'session/set_config_option');
    assert.deepEqual(sent[2].params, { sessionId: 's1', configId: 'model', value: 'opencode/big-pickle' });
    receive({ id: sent[2].id, result: { configOptions: [{ id: 'model', currentValue: 'opencode/big-pickle' }] } });
    await started;
    assert.equal(state.model, 'opencode/big-pickle');
  });

  test('a failed handshake fails the turn, and the next turn tries again', async () => {
    const { state, sent, receive } = connect({ ...AGENT, resumeId: 'gone' });
    const started = opencodeProvider.startTurn(state, [{ type: 'text', text: 'hi' }]);
    receive({ id: sent[0].id, result: {} });
    await tick();
    receive({ id: sent[1].id, error: { code: -32603, message: 'Session not found' } });
    await assert.rejects(started, /Session not found/);

    opencodeProvider.startTurn(state, [{ type: 'text', text: 'hi' }]).catch(() => {});
    assert.equal(sent.at(-1).method, 'initialize');
  });

  test('accumulates text, tool calls and usage into one turn', () => {
    const { state, receive } = connect();
    state.sessionId = 's1';
    state.model = 'ollama/local-agent';
    state.promptId = 7;
    const chunks = [];
    const statuses = [];
    const turn = opencodeProvider.createTurnAccumulator({ onChunk: (t) => chunks.push(t), onStatus: (s) => statuses.push(s) });
    const feed = (message) => {
      const event = receive(message);
      if (event) turn.handleEvent(event);
    };

    feed(update('tool_call', { toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending', rawInput: {} }));
    feed(update('tool_call_update', { toolCallId: 't1', status: 'in_progress', kind: 'execute', title: 'echo ok', rawInput: { command: 'echo ok' } }));
    feed(update('tool_call_update', { toolCallId: 't1', status: 'completed', title: 'echo ok', content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }] }));
    feed(update('agent_message_chunk', { content: { type: 'text', text: 'Ran ' } }));
    feed(update('agent_message_chunk', { content: { type: 'text', text: 'it.' } }));
    feed(update('usage_update', { used: 3162, size: 16384, cost: { amount: 0.25, currency: 'USD' } }));
    assert.equal(turn.done, false);
    feed({ id: 7, result: { stopReason: 'end_turn', usage: { inputTokens: 17, outputTokens: 17, totalTokens: 3179, cachedReadTokens: 3145 } } });

    assert.equal(turn.done, true);
    assert.equal(turn.fullText, 'Ran it.');
    assert.deepEqual(chunks, ['Ran ', 'it.']);
    assert.deepEqual(statuses, ['Running: echo ok']);
    assert.deepEqual([...turn.toolCalls.values()], [{ id: 't1', name: 'bash', label: 'Running: echo ok', result: 'ok\n', isError: false }]);
    assert.equal(turn.contextTokens, 3162);
    assert.deepEqual(turn.usage, { inputTokens: 17, outputTokens: 17, cacheCreationInputTokens: 0, cacheReadInputTokens: 3145 });
    assert.equal(turn.totalCostUsd, 0.25);
    assert.equal(turn.sessionId, 's1');
    assert.equal(turn.model, 'ollama/local-agent');
    assert.equal(turn.errorMessage, null);
  });

  test('an error response to the prompt ends the turn as an error', () => {
    const { state, receive } = connect();
    state.promptId = 3;
    const turn = opencodeProvider.createTurnAccumulator();
    turn.handleEvent(receive({ id: 3, error: { code: -32603, message: 'model unreachable' } }));
    assert.equal(turn.done, true);
    assert.equal(turn.errorMessage, 'model unreachable');
  });

  test('reports the commands its session offers as skills, and nothing as unsolicited turn content', () => {
    const signal = opencodeProvider.inspectEvent(update('available_commands_update', { availableCommands: [{ name: 'review' }, { name: 'docs' }] }));
    assert.deepEqual(signal, { isTurnContent: false, skills: ['review', 'docs'] });
    assert.equal(opencodeProvider.inspectEvent(update('agent_message_chunk', { content: { type: 'text', text: 'x' } })).isTurnContent, false);
  });
});

describe('opencode permission requests', () => {
  const ask = (toolCall) => ({
    id: 0,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall,
      options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }],
    },
  });

  test('rejects an ungranted command and reports it as a denial', () => {
    const { sent, receive } = connect();
    receive(update('tool_call', { toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending' }));
    const event = receive(ask({ toolCallId: 't1', title: 'git push', kind: 'execute', rawInput: { command: 'git push' } }));

    assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject' } } });
    assert.deepEqual(event, { type: 'permission_denied', denial: { tool_name: 'bash', tool_use_id: 't1', tool_input: { command: 'git push' } } });
  });

  test('allows a command once every sub-command is granted, and consumes the request', () => {
    const agent = { ...AGENT, allowedToolPatterns: ['bash(git add:*)', 'bash(git commit:*)'] };
    const { sent, receive } = connect(agent);
    const event = receive(ask({ toolCallId: 't2', kind: 'execute', rawInput: { command: 'git add -A && git commit -m x' } }));
    assert.equal(event, null);
    assert.equal(sent.at(-1).result.outcome.optionId, 'once');
  });

  test('grants follow the provider\'s own pattern syntax, which the decision reads back', () => {
    const { patterns } = opencodeProvider.grantFor('bash', 'npm test | tail -5');
    assert.deepEqual(patterns, ['bash(npm test:*)', 'bash(tail -5:*)']);
    const agent = { ...AGENT, allowedToolPatterns: patterns };
    assert.equal(decidePermission(agent, { tool_name: 'bash', tool_input: { command: 'npm test | tail -5' } }), true);
    assert.equal(decidePermission(agent, { tool_name: 'bash', tool_input: { command: 'npm publish' } }), false);
  });

  test('file tools are allowed inside the working directory and granted directories only', () => {
    const agent = { ...AGENT, extraAllowedPaths: ['/shared'] };
    const edit = (path) => ({ tool_name: 'edit', tool_input: { file_path: path } });
    assert.equal(decidePermission(agent, edit('/work/src/a.js')), true);
    assert.equal(decidePermission(agent, edit('/shared/b.txt')), true);
    assert.equal(decidePermission(agent, edit('/workshop/c.txt')), false);
    assert.equal(decidePermission(agent, edit('/etc/hosts')), false);
    assert.deepEqual(opencodeProvider.grantFor('edit', '/etc/hosts'), { path: '/etc' });
  });

  test('YOLO mode allows everything', () => {
    const agent = { ...AGENT, dangerouslySkipPermissions: true };
    assert.equal(decidePermission(agent, { tool_name: 'bash', tool_input: { command: 'rm -rf build' } }), true);
  });

  test('refuses any other client request', () => {
    const { sent, receive } = connect();
    assert.equal(receive({ id: 5, method: 'fs/read_text_file', params: {} }), null);
    assert.equal(sent.at(-1).error.code, -32601);
  });
});
