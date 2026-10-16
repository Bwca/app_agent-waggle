/**
 * @fileoverview Unit tests for createTurnAccumulator (server/services/
 * providers/claude.js)'s `result` event handling — a pure function, no
 * `claude` subprocess involved.
 *
 * Context: confirmed live against the real CLI that a `result` event isn't
 * always a successful completion — an agent created with a bogus resumeId
 * (an invalid `--resume` flag) produces a well-formed `result` event with
 * `is_error: true`, `subtype: "error_during_execution"`, and the actual
 * message in `errors` (not `result`, which is why the old code's fallback
 * landed on the empty `fullText` instead). Before turn.errorMessage existed,
 * runOneTurn's handleEvent treated every `result` event as success, so this
 * resolved the turn with an empty string instead of surfacing the error —
 * an empty reply bubble with zero diagnostic, silently, on every turn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnAccumulator } from '../../server/services/providers/claude.js';

describe('createTurnAccumulator — result event error detection', () => {
  test('a successful result event leaves errorMessage null', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', result: 'all good' });
    assert.equal(turn.errorMessage, null);
    assert.equal(turn.resultText, 'all good');
    assert.equal(turn.done, true);
  });

  test('an is_error result event with an errors array sets errorMessage from it', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['Error: --resume requires a valid session ID or session title when used with --print.'],
    });
    assert.equal(turn.errorMessage, 'Error: --resume requires a valid session ID or session title when used with --print.');
  });

  test('multiple errors are joined', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', is_error: true, errors: ['first problem', 'second problem'] });
    assert.equal(turn.errorMessage, 'first problem; second problem');
  });

  test('an is_error result event with no errors array falls back to resultText, then a generic message', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', is_error: true, result: 'some result text' });
    assert.equal(turn.errorMessage, 'some result text');

    const turnNoText = createTurnAccumulator();
    turnNoText.handleEvent({ type: 'result', is_error: true });
    assert.equal(turnNoText.errorMessage, 'unknown error');
  });

  test('a non-result event never sets errorMessage, even with is_error-looking fields', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'assistant', is_error: true, message: { content: [] } });
    assert.equal(turn.errorMessage, null);
  });
});

describe('createTurnAccumulator — "/clear" (conversation_reset) handling', () => {
  // Confirmed live against the real CLI (v2.1.260) via a raw two-turn
  // --print --input-format=stream-json --output-format=stream-json run: a
  // bare "/clear" does NOT produce the synthetic assistant message
  // "/chrome"/"/help" do (wasLocalCommand's shape) — it fires a standalone
  // {"type":"system","subtype":"conversation_reset"} event, still tagged
  // with the OLD session_id, immediately followed by a fresh "system"/
  // "init" carrying a BRAND-NEW session_id, and this turn's own closing
  // `result` event already reports that new id — i.e. turn.sessionId (set
  // generically from every event's session_id) ends up holding the new one
  // by the time the turn resolves.
  test('a conversation_reset event sets contextCleared, independent of wasLocalCommand', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'system', subtype: 'init', session_id: 'old-session' });
    turn.handleEvent({ type: 'system', subtype: 'conversation_reset', session_id: 'old-session' });
    turn.handleEvent({ type: 'system', subtype: 'init', session_id: 'new-session' });
    turn.handleEvent({ type: 'result', result: '', session_id: 'new-session' });
    assert.equal(turn.contextCleared, true);
    assert.equal(turn.wasLocalCommand, false, 'conversation_reset is a different wire shape than the synthetic-assistant local commands');
    assert.equal(turn.sessionId, 'new-session', 'the turn must end up holding the ROTATED session id, not the one it started with');
  });

  test('an ordinary turn never sets contextCleared', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    turn.handleEvent({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }] } });
    turn.handleEvent({ type: 'result', result: 'hi', session_id: 'sess-1' });
    assert.equal(turn.contextCleared, false);
  });
});

describe('createTurnAccumulator — text across a tool call', () => {
  // Confirmed live against the real CLI (`claude --print --output-format=
  // stream-json --verbose`): a turn with "text, tool call, more text" isn't
  // one assistant message whose content array keeps growing across the tool
  // call — it's a sequence of SEPARATE assistant messages, a new message.id
  // each time a tool call interrupts the model's output, each with its own
  // content array that starts fresh (same shape reproduced inline below).
  // Before this was tracked per (message id, block index), the second
  // message's short, just-started text got sliced against the first
  // message's already-longer length, dropping or mangling everything after
  // the turn's first tool call.

  test('text before and after a tool call is both captured, in order, with nothing dropped', () => {
    const chunks = [];
    const turn = createTurnAccumulator({ onChunk: (text) => chunks.push(text) });

    // First assistant message: commentary, then a tool call. The CLI sends
    // growing snapshots of the SAME message as it's produced.
    turn.handleEvent({ type: 'assistant', message: { id: 'msg_1', content: [] } });
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Let me check something first.' }] },
    });
    turn.handleEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Let me check something first.' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    turn.handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file1\nfile2' }] },
    });

    // Second assistant message: a brand new message.id, own content array
    // starting fresh — NOT a continuation of msg_1's text.
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_2', content: [{ type: 'text', text: 'Found it, done.' }] },
    });
    turn.handleEvent({ type: 'result', result: 'Found it, done.' });

    assert.equal(turn.fullText, 'Let me check something first.Found it, done.');
    assert.deepEqual(chunks, ['Let me check something first.', 'Found it, done.']);
  });

  test('a second text block at the same index in a new message does not get its head sliced off', () => {
    // The exact failure mode: msg_1's text block (30 chars) sets the old
    // turn-wide length to 30; msg_2's text block starts short and only
    // grows past 30 once fully formed, at which point slicing it against
    // the stale turn-wide length used to emit a tail fragment starting
    // mid-string instead of the block's actual start.
    const chunks = [];
    const turn = createTurnAccumulator({ onChunk: (text) => chunks.push(text) });

    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'A'.repeat(30) }] },
    });
    turn.handleEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'A'.repeat(30) }, { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
      },
    });
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_2', content: [{ type: 'text', text: 'short reply' }] },
    });

    assert.equal(turn.fullText, `${'A'.repeat(30)}short reply`);
    assert.equal(chunks.at(-1), 'short reply');
  });
});

describe('createTurnAccumulator — contextTokens', () => {
  // The `result` event's usage is summed across every request in the turn
  // (one per tool-call step, each re-reading the whole context), so it
  // wildly overstates the session's actual size. Observed live: a ~1M
  // context reported as 33M after a long tool-heavy turn.
  const assistant = (id, usage) => ({
    type: 'assistant',
    message: { id, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'x' }], usage },
  });

  test('uses the last request\'s usage, not the result event\'s turn-wide sum', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent(assistant('msg_1', { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 150_000 }));
    turn.handleEvent(assistant('msg_2', { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 151_000 }));
    turn.handleEvent({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 1500, cache_read_input_tokens: 301_000 },
    });
    assert.equal(turn.contextTokens, 3 + 500 + 151_000);
    assert.equal(turn.usage.cacheReadInputTokens, 301_000);
  });

  test('stays null for a turn with no real model request', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_1', model: '<synthetic>', content: [{ type: 'text', text: 'help' }], usage: { input_tokens: 0 } },
    });
    turn.handleEvent({ type: 'result', result: 'help' });
    assert.equal(turn.contextTokens, null);
  });
});
