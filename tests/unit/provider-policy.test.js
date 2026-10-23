/**
 * @fileoverview Tests which provider a new agent may run as under Settings'
 * multi-provider mode (server/services/providerPolicy.js): off by default,
 * when only Claude Code is allowed; on, any registered provider, with the
 * default chosen in Settings.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APP_LOG_DIR = mkdtempSync(join(tmpdir(), 'agentwaggle-policy-'));
process.env.APP_LOG_LEVEL = 'silent';
process.env.APP_DB_FILE = ':memory:';

let db;
let policy;

describe('newAgentProvider', () => {
  before(async () => {
    db = await import('../../server/store/db.js');
    await db.loadDb();
    policy = await import('../../server/services/providerPolicy.js');
  });

  test('off by default: a new agent runs as Claude Code, and another provider is refused', async () => {
    assert.equal(db.getMultiProvider(), false);
    assert.deepEqual(policy.newAgentProvider(undefined), { providerId: 'claude' });
    assert.deepEqual(policy.newAgentProvider('claude'), { providerId: 'claude' });
    assert.match(policy.newAgentProvider('opencode').error, /multi-provider mode/i);
  });

  test('a default provider chosen in Settings is ignored while the mode is off', async () => {
    await db.setDefaultProvider('cursor');
    assert.deepEqual(policy.newAgentProvider(undefined), { providerId: 'claude' });
  });

  test('on: any registered provider, and the chosen default when none is asked for', async () => {
    await db.setMultiProvider(true);
    await db.setDefaultProvider('opencode');
    assert.deepEqual(policy.newAgentProvider(undefined), { providerId: 'opencode' });
    assert.deepEqual(policy.newAgentProvider('cursor'), { providerId: 'cursor' });
    assert.match(policy.newAgentProvider('nope').error, /unknown agent provider/i);
  });

  test('a stored default that is no longer registered falls back to Claude Code', async () => {
    await db.setDefaultProvider('gone');
    assert.deepEqual(policy.newAgentProvider(undefined), { providerId: 'claude' });
  });
});
