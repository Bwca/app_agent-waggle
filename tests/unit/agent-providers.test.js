/**
 * @fileoverview Unit tests for the agent-provider registry (server/services/
 * providers/index.js) — which provider an agent runs as. Every agent is
 * Claude until agents carry a `provider` field of their own.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER_ID, getProvider, providerForAgent } from '../../server/services/providers/index.js';
import { claudeProvider } from '../../server/services/providers/claude.js';

describe('agent provider registry', () => {
  test('defaults to Claude', () => {
    assert.equal(DEFAULT_PROVIDER_ID, 'claude');
    assert.equal(getProvider(), claudeProvider);
  });

  test('an agent with no provider field runs as the default', () => {
    assert.equal(providerForAgent({ id: 'a', workingDir: '/tmp' }), claudeProvider);
  });

  test('an unknown provider id fails loudly instead of silently running Claude', () => {
    assert.throws(() => providerForAgent({ id: 'a', provider: 'nope' }), /Unknown agent provider: nope/);
  });
});

describe('Claude provider', () => {
  test('spawns the same persistent stream-json process as before', () => {
    const { args } = claudeProvider.spawnCommand({ id: 'a', workingDir: '/work', resumeId: 's1' });
    assert.ok(args.includes('--input-format=stream-json'));
    assert.ok(args.includes('--output-format=stream-json'));
    assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', '/work']);
    assert.ok(args.includes('--resume=s1'));
  });

  test('writes one stream-json user message per turn', () => {
    const content = [{ type: 'text', text: 'hi' }];
    assert.equal(claudeProvider.encodeTurn(content), '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n');
  });

  test('reads skills and MCP status off init, and nothing else as turn content', () => {
    const signal = claudeProvider.inspectEvent({ type: 'system', subtype: 'init', skills: ['review'], mcp_servers: [{ name: 'x', status: 'connected' }] });
    assert.deepEqual(signal, { isTurnContent: false, skills: ['review'], mcpServers: [{ name: 'x', status: 'connected' }] });
  });

  test('reads a compaction off compact_boundary', () => {
    const signal = claudeProvider.inspectEvent({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 100 } });
    assert.deepEqual(signal.compaction, { trigger: 'auto', preTokens: 900, postTokens: 100 });
  });

  test('marks assistant, user and result events as turn content', () => {
    for (const type of ['assistant', 'user', 'result']) {
      assert.equal(claudeProvider.inspectEvent({ type }).isTurnContent, true, type);
    }
  });
});
