/**
 * @fileoverview Unit tests for handleUnsolicitedEvent's routing (server/
 * services/agentProcessManager.js) — pure function/Map logic, no `claude`
 * subprocess involved.
 *
 * Regression for a real incident: an agent running its own self-rescheduled
 * background check-in loop kept hitting the account's still-active session
 * limit on every retry. Each retry's unprompted background turn ended in a
 * `result` event with is_error:true, but handleUnsolicitedEvent only ever
 * checked `turn.fullText`/`turn.toolCalls.size` before handing output to
 * onBackgroundTurn's handler — which persists+broadcasts it as a genuine
 * agent reply. Since the failing retry's accumulator had collected a
 * tool_use before the error (a real-world background turn's shape: "run a
 * check, then report"), that guard let it through, and the bare error text
 * ("You've hit your session limit · resets ...") got posted into the chat
 * as if the agent had said it — once per retry, for hours, unprompted, with
 * no scheduled message behind it to see or cancel. The foreground turn path
 * (runOneTurn) has always special-cased turn.errorMessage before treating a
 * `result` as success; these tests pin the same distinction now made for
 * the background path, via the dedicated onBackgroundError handler.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleUnsolicitedEvent,
  onBackgroundTurn,
  onBackgroundError,
} from '../../server/services/agentProcessManager.js';
import { claudeProvider } from '../../server/services/providers/claude.js';

describe('handleUnsolicitedEvent — background turn vs background error routing', () => {
  const agentId = 'test-agent-background-unprompted';
  let turnCalls;
  let errorCalls;

  beforeEach(() => {
    turnCalls = [];
    errorCalls = [];
    onBackgroundTurn(agentId, (turn) => turnCalls.push(turn));
    onBackgroundError(agentId, (err) => errorCalls.push(err));
  });

  test('a genuine unprompted completion (e.g. a backgrounded Bash task finishing) fires onBackgroundTurn, not onBackgroundError', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    handleUnsolicitedEvent(proc, {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'The background command finished.' }] },
    });
    handleUnsolicitedEvent(proc, { type: 'result', is_error: false, result: 'The background command finished.' });

    assert.equal(errorCalls.length, 0);
    assert.equal(turnCalls.length, 1);
    assert.equal(turnCalls[0].text, 'The background command finished.');
  });

  test('an unprompted background retry that errors on a still-active session limit fires onBackgroundError, never onBackgroundTurn', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    // Mirrors the real incident's shape: a tool call completes, then the
    // model call meant to summarize/report hits the session limit.
    handleUnsolicitedEvent(proc, {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: "I'll check and report back." },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 1' } },
        ],
      },
    });
    handleUnsolicitedEvent(proc, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done', is_error: false }] },
    });
    handleUnsolicitedEvent(proc, {
      type: 'result',
      is_error: true,
      errors: ["You've hit your session limit · resets 11:20am (Australia/Darwin)"],
    });

    assert.equal(turnCalls.length, 0, 'the raw error text must never be reported as if the agent genuinely said it');
    assert.equal(errorCalls.length, 1);
    assert.match(errorCalls[0].errorMessage, /session limit/);
  });

  test('a background result that errors with no preceding content is still routed to onBackgroundError, not silently dropped', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    handleUnsolicitedEvent(proc, { type: 'result', is_error: true, errors: ['boom'] });

    assert.equal(turnCalls.length, 0);
    assert.equal(errorCalls.length, 1);
    assert.equal(errorCalls[0].errorMessage, 'boom');
  });

  test('repeated errored retries each fire onBackgroundError independently (no dedup/suppression at this layer)', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    for (let i = 0; i < 3; i += 1) {
      handleUnsolicitedEvent(proc, { type: 'result', is_error: true, errors: ['still limited'] });
    }

    assert.equal(turnCalls.length, 0);
    assert.equal(errorCalls.length, 3);
  });
});
