/**
 * @fileoverview Unit tests for normalizeAutocompact (server/public/autocompact.js).
 * The accepted set mirrors what the installed `claude` CLI (2.1.301)
 * accepts for --autocompact, checked directly against it: a value it
 * rejects stops the agent's process from starting at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutocompact } from '../../server/public/autocompact.js';

describe('normalizeAutocompact', () => {
  test('accepts what the CLI accepts, in canonical form', () => {
    assert.equal(normalizeAutocompact('auto'), 'auto');
    assert.equal(normalizeAutocompact(' AUTO '), 'auto');
    assert.equal(normalizeAutocompact('150k'), '150k');
    assert.equal(normalizeAutocompact('200K'), '200k');
    assert.equal(normalizeAutocompact('150000'), '150k');
    assert.equal(normalizeAutocompact('150500'), '150500');
    assert.equal(normalizeAutocompact('1M'), '1M');
    assert.equal(normalizeAutocompact('1m'), '1M');
    assert.equal(normalizeAutocompact('1000k'), '1M');
    assert.equal(normalizeAutocompact('100k'), '100k');
  });

  test('refuses what the CLI rejects, or what would be ambiguous', () => {
    for (const value of ['50k', '2M', '1.5M', '1000001', 'big', '', '200', '-200k', undefined, 200000]) {
      assert.equal(normalizeAutocompact(value), null, `${JSON.stringify(value)} should be refused`);
    }
  });
});
