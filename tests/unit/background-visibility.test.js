/**
 * @fileoverview Unit tests for how an agent's background work is surfaced
 * (server/services/agentProcessManager.js) — pure function/Map logic, no
 * `claude` subprocess involved.
 *
 * Regression for a reported bug: an agent that backgrounded a command and
 * ended its turn with "I'll wait for that to finish" looked exactly like an
 * idle agent (nothing showed it was still waiting on anything), and the
 * turn the CLI later resumed on its own was invisible until its final
 * `result` — sometimes many minutes and 50+ tool calls later.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleUnsolicitedEvent,
  applyBackgroundTasksChanged,
  onBackgroundTurn,
  onBackgroundError,
  onBackgroundStream,
  onBackgroundTasksChanged,
} from '../../server/services/agentProcessManager.js';

describe('applyBackgroundTasksChanged', () => {
  const agentId = 'test-agent-bg-tasks';
  let calls;

  beforeEach(() => {
    calls = [];
    onBackgroundTasksChanged(agentId, (tasks) => calls.push(tasks));
  });

  test('maps the CLI\'s own background_tasks_changed shape (captured live) and reports the full list', () => {
    const proc = { agentId };
    applyBackgroundTasksChanged(proc, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b0muwra4y', run_id: 'x', task_type: 'local_bash', description: 'Sleep 15 seconds then echo done' }],
    });
    const expected = [{ id: 'b0muwra4y', type: 'local_bash', description: 'Sleep 15 seconds then echo done' }];
    assert.deepEqual(proc.backgroundTasks, expected);
    assert.deepEqual(calls, [expected]);
  });

  test('an empty list (task finished) clears it', () => {
    const proc = { agentId, backgroundTasks: [{ id: 'a', type: 'local_bash', description: 'x' }] };
    applyBackgroundTasksChanged(proc, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    assert.deepEqual(proc.backgroundTasks, []);
    assert.deepEqual(calls, [[]]);
  });
});

describe('handleUnsolicitedEvent — live streaming of a self-resumed turn', () => {
  const agentId = 'test-agent-bg-stream';
  let opened;
  let turnCalls;
  let errorCalls;

  beforeEach(() => {
    opened = [];
    turnCalls = [];
    errorCalls = [];
    onBackgroundStream(agentId, () => {
      const stream = { streamId: `s${opened.length + 1}`, chunks: [], statuses: [], discarded: false };
      stream.onChunk = (text) => stream.chunks.push(text);
      stream.onStatus = (status) => stream.statuses.push(status);
      stream.discard = () => { stream.discarded = true; };
      opened.push(stream);
      return stream;
    });
    onBackgroundTurn(agentId, (turn) => turnCalls.push(turn));
    onBackgroundError(agentId, (err) => errorCalls.push(err));
  });

  test('opens a stream on the first event, feeds it live, and hands its streamId to onBackgroundTurn', () => {
    const proc = { agentId, background: null };
    handleUnsolicitedEvent(proc, {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
    });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].statuses.length, 1);

    handleUnsolicitedEvent(proc, {
      type: 'assistant',
      message: { id: 'm2', content: [{ type: 'text', text: 'Tests pass.' }] },
    });
    assert.deepEqual(opened[0].chunks, ['Tests pass.']);

    handleUnsolicitedEvent(proc, { type: 'result', is_error: false, result: 'Tests pass.' });
    assert.equal(turnCalls.length, 1);
    assert.equal(turnCalls[0].streamId, 's1');
    assert.equal(opened[0].discarded, false);
    assert.equal(proc.backgroundStream, null);
  });

  test('a background error passes its streamId to onBackgroundError', () => {
    const proc = { agentId, background: null };
    handleUnsolicitedEvent(proc, {
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }] },
    });
    handleUnsolicitedEvent(proc, { type: 'result', is_error: true, errors: ['boom'] });
    assert.equal(turnCalls.length, 0);
    assert.deepEqual(errorCalls, [{ errorMessage: 'boom', streamId: 's1' }]);
  });

  test('a contentless unsolicited turn discards its stream instead of leaving it open', () => {
    const proc = { agentId, background: null };
    handleUnsolicitedEvent(proc, { type: 'assistant', message: { id: 'm1', content: [] } });
    handleUnsolicitedEvent(proc, { type: 'result', is_error: false, result: '' });
    assert.equal(turnCalls.length, 0);
    assert.equal(opened[0].discarded, true);
  });
});
