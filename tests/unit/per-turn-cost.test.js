/**
 * @fileoverview Unit tests for withPerTurnCost (server/services/
 * providers/claude.js). Confirmed against the real CLI: a persistent
 * stream-json process reports `total_cost_usd` as a running total for the
 * whole process, not per turn, so it has to be converted before anything
 * records it as one turn's cost.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withPerTurnCost } from '../../server/services/providers/claude.js';

describe('withPerTurnCost', () => {
  test('converts the running total into each turn\'s own cost', () => {
    const proc = { costSoFar: 0 };
    const costs = [12.01, 12.33, 13.36].map((total) => withPerTurnCost(proc, { type: 'result', total_cost_usd: total }).total_cost_usd);
    assert.deepEqual(costs.map((c) => Number(c.toFixed(2))), [12.01, 0.32, 1.03]);
    assert.equal(proc.costSoFar, 13.36);
  });

  test('an errored turn that spent nothing costs 0, not the running total again', () => {
    const proc = { costSoFar: 13.73 };
    assert.equal(withPerTurnCost(proc, { type: 'result', is_error: true, total_cost_usd: 13.73 }).total_cost_usd, 0);
  });

  test('leaves non-result and uncosted events untouched', () => {
    const proc = { costSoFar: 5 };
    const assistant = { type: 'assistant', message: {} };
    assert.equal(withPerTurnCost(proc, assistant), assistant);
    const uncosted = { type: 'result', result: 'x' };
    assert.equal(withPerTurnCost(proc, uncosted), uncosted);
    assert.equal(proc.costSoFar, 5);
  });
});
