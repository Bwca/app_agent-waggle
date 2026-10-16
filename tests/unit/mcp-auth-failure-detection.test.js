/**
 * @fileoverview Unit tests for looksLikeMcpAuthFailure (server/services/providers/claude.js)
 * — a pure function, no `claude` subprocess involved.
 *
 * Reported live: a user re-authenticated an MCP server (Linear) via `/login`
 * in a separate real terminal, but the persistent agent process already
 * running in the chat kept failing tool calls with "Failed to authenticate:
 * OAuth session expired..." — because MCP auth is only ever read once, at
 * that process's own spawn time. This predicate is how the turn-completion
 * handler in agentProcessManager.js recognizes that failure (confirmed via
 * the installed `claude` binary's own embedded wording) and evicts the
 * process so the next turn spawns fresh and picks up the renewed auth.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMcpAuthFailure } from '../../server/services/providers/claude.js';

describe('looksLikeMcpAuthFailure', () => {
  test('matches the exact wording embedded in the claude CLI binary', () => {
    assert.ok(looksLikeMcpAuthFailure('Failed to authenticate: OAuth session expired and could not be refreshed'));
  });

  test('matches the slightly different wording reported live ("renewed" instead of "refreshed")', () => {
    assert.ok(looksLikeMcpAuthFailure('Failed to authenticate: OAuth session expired and could not be renewed'));
  });

  test('is case-insensitive', () => {
    assert.ok(looksLikeMcpAuthFailure('failed to authenticate: oauth session EXPIRED and could not be refreshed'));
  });

  test('matches when embedded in a longer assistant reply, not just standalone', () => {
    const text = 'I tried to check your Linear items, but: Failed to authenticate: OAuth session expired and could not be refreshed. You may need to log in again.';
    assert.ok(looksLikeMcpAuthFailure(text));
  });

  test('a normal, unrelated reply does not match', () => {
    assert.equal(looksLikeMcpAuthFailure('Here are your Linear items: 3 open issues assigned to you.'), false);
  });

  test('"failed to authenticate" alone, without "could not be", does not match', () => {
    // Narrow on purpose — avoids false-positiving on unrelated auth errors
    // (e.g. a bad API key) that a respawn wouldn't actually fix.
    assert.equal(looksLikeMcpAuthFailure('Failed to authenticate: invalid API key.'), false);
  });

  test('empty/missing text does not match', () => {
    assert.equal(looksLikeMcpAuthFailure(''), false);
    assert.equal(looksLikeMcpAuthFailure(undefined), false);
    assert.equal(looksLikeMcpAuthFailure(null), false);
  });
});
