/**
 * @fileoverview Tests what of the server's environment each provider's
 * binary gets (server/services/agentEnv.js's providerEnv): nothing trusted
 * to one CLI reaches another's agents, and Agentwaggle's own secrets and
 * the launching Claude Code session's variables reach none.
 *
 * Regression: every agent got the server's whole environment, so opencode
 * and Cursor agents held MCP_AUTH_TOKEN, and a server started from a Claude
 * Code session passed that session's messaging token to every agent.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = mkdtempSync(join(tmpdir(), 'agentwaggle-env-'));
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
process.env.APP_LOG_DIR = logDir;
process.env.APP_LOG_LEVEL = 'silent';
process.env.APP_DB_FILE = ':memory:';

const { providerEnv } = await import('../../server/services/agentEnv.js');
const { getProvider, listProviders } = await import('../../server/services/providers/index.js');

const SERVER_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  MCP_AUTH_TOKEN: 'app-secret',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'launcher-session',
  CLAUDE_CODE_MESSAGING_TOKEN: 'launcher-token',
  CLAUDE_CODE_SSE_PORT: '12345',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-login',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude',
  ANTHROPIC_API_KEY: 'anthropic-key',
  OPENCODE_CONFIG: '/home/someone/opencode.json',
  OPENAI_API_KEY: 'openai-key',
  CURSOR_API_KEY: 'cursor-key',
  SSH_AUTH_SOCK: '/run/ssh-agent.sock',
  GIT_ASKPASS: '/askpass.sh',
  VSCODE_GIT_ASKPASS_MAIN: '/askpass-main.js',
  GH_TOKEN: 'github-token',
};

const envNames = (providerId) => Object.keys(providerEnv(getProvider(providerId), listProviders(), SERVER_ENV)).sort();

describe('providerEnv', () => {
  test('every provider says what it owns and whether it gets the user\'s credentials', () => {
    for (const provider of listProviders()) {
      assert.equal(typeof provider.env?.owns, 'function', `${provider.id} env.owns`);
      assert.equal(typeof provider.env?.userCredentials, 'boolean', `${provider.id} env.userCredentials`);
    }
  });

  test('a Claude agent gets Claude\'s own and the user\'s credentials, nothing of another CLI\'s', () => {
    assert.deepEqual(envNames('claude'), [
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR',
      'GH_TOKEN', 'GIT_ASKPASS', 'HOME', 'PATH', 'SSH_AUTH_SOCK', 'VSCODE_GIT_ASKPASS_MAIN',
    ]);
  });

  test('an opencode agent gets only its own keys, nothing of Claude\'s or Cursor\'s, and no git or SSH credentials', () => {
    assert.deepEqual(envNames('opencode'), ['HOME', 'OPENAI_API_KEY', 'OPENCODE_CONFIG', 'PATH']);
  });

  test('a Cursor agent gets only its own key', () => {
    assert.deepEqual(envNames('cursor'), ['CURSOR_API_KEY', 'HOME', 'PATH']);
  });
});

describe('a spawned agent process', () => {
  let manager;
  const envFile = join(logDir, 'env.json');

  before(async () => {
    // Loaded for the user's locale, which turn error messages are worded in.
    await (await import('../../server/store/db.js')).loadDb();
    manager = await import('../../server/services/agentProcessManager.js');
  });

  after(async () => {
    await manager.killAll();
    rmSync(logDir, { recursive: true, force: true });
  });

  test('is started with the filtered environment, not the server\'s own', async () => {
    process.env.MCP_AUTH_TOKEN = 'app-secret';
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'launcher-token';
    process.env.FAKE_CLAUDE_ENV_FILE = envFile;
    try {
      await manager.runTurn({ id: 'env-agent', name: 'Envy', workingDir: tmpdir() }, [{ type: 'text', text: 'hi' }], { onChunk: () => {} });
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
      delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      delete process.env.FAKE_CLAUDE_ENV_FILE;
    }
    const names = JSON.parse(readFileSync(envFile, 'utf8'));
    assert.ok(names.includes('PATH'));
    assert.ok(!names.includes('MCP_AUTH_TOKEN'), 'the app\'s MCP token must not reach an agent');
    assert.ok(!names.includes('CLAUDE_CODE_MESSAGING_TOKEN'), 'the launching session\'s token must not reach an agent');
  });
});
