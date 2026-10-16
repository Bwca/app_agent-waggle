/**
 * @fileoverview Unit tests for onBackgroundUsage (server/services/
 * agentProcessManager.js): a turn the agent's process runs entirely on its
 * own still spends real tokens, and that spend has to be reported whatever
 * the turn's outcome — before this, none of it was ever recorded.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleUnsolicitedEvent,
  onBackgroundTurn,
  onBackgroundError,
  onBackgroundUsage,
} from '../../server/services/agentProcessManager.js';
import { claudeProvider } from '../../server/services/providers/claude.js';

describe('handleUnsolicitedEvent — background usage reporting', () => {
  const agentId = 'test-agent-background-usage';
  let usageCalls;

  beforeEach(() => {
    usageCalls = [];
    onBackgroundTurn(agentId, () => {});
    onBackgroundError(agentId, () => {});
    onBackgroundUsage(agentId, (u) => usageCalls.push(u));
  });

  const assistant = (text) => ({
    type: 'assistant',
    message: {
      id: 'm1',
      model: 'claude-sonnet-5',
      content: text ? [{ type: 'text', text }] : [],
      usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50_000 },
    },
  });
  const result = (extra) => ({
    type: 'result',
    usage: { input_tokens: 2, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 50_000 },
    total_cost_usd: 0.42,
    duration_ms: 1234,
    ...extra,
  });

  test('a real background reply reports its usage', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    handleUnsolicitedEvent(proc, assistant('The background command finished.'));
    handleUnsolicitedEvent(proc, result({ result: 'The background command finished.' }));

    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0].totalCostUsd, 0.42);
    assert.equal(usageCalls[0].contextTokens, 50_102);
    assert.equal(usageCalls[0].usage.outputTokens, 30);
    assert.equal(usageCalls[0].isError, false);
  });

  test('an errored background retry still reports what it spent', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    handleUnsolicitedEvent(proc, assistant(''));
    handleUnsolicitedEvent(proc, result({ is_error: true, errors: ["You've hit your session limit"] }));

    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0].isError, true);
    assert.equal(usageCalls[0].totalCostUsd, 0.42);
  });

  test('a background turn with nothing to post still reports its usage', () => {
    const proc = { agentId, provider: claudeProvider, background: null };
    handleUnsolicitedEvent(proc, assistant(''));
    handleUnsolicitedEvent(proc, result({ result: '' }));

    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0].totalCostUsd, 0.42);
  });
});
