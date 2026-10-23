/**
 * @fileoverview Unit tests for listing a provider's models for the model
 * picker (server/services/agentRunner.js's listProviderModels and
 * parseModelList), against throwaway shell scripts standing in for a CLI.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProviderModels, parseModelList } from '../../server/services/agentRunner.js';

const dir = mkdtempSync(join(tmpdir(), 'provider-models-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A provider whose modelsCommand runs the given shell script.
 * @param {string} script
 */
function fakeProvider(script) {
  const bin = join(dir, `bin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return {
    id: 'fake',
    displayName: 'fake',
    env: { owns: () => false, userCredentials: false },
    modelsCommand: () => ({ command: bin, args: ['models'] }),
  };
}

describe('parseModelList', () => {
  test('takes one model ID per line, deduplicated, in order', () => {
    assert.deepEqual(parseModelList('ollama/a\n\n  opencode/b  \nollama/a\n'), ['ollama/a', 'opencode/b']);
  });

  test('skips anything that isn\'t a bare ID', () => {
    assert.deepEqual(parseModelList('Fetching models...\nollama/a\n'), ['ollama/a']);
  });
});

describe('listProviderModels', () => {
  test('returns what the provider lists', async () => {
    const result = await listProviderModels(fakeProvider('printf "ollama/a\\nopencode/b\\n"'));
    assert.deepEqual(result, { ok: true, models: ['ollama/a', 'opencode/b'] });
  });

  test('runs in the agent\'s working directory, where a project configures its models', async () => {
    const result = await listProviderModels(fakeProvider('basename "$PWD"'), { workingDir: dir });
    assert.deepEqual(result, { ok: true, models: [dir.split('/').pop()] });
  });

  test('reports a failing CLI\'s own error', async () => {
    const result = await listProviderModels(fakeProvider('echo "no config" >&2; exit 3'));
    assert.deepEqual(result, { ok: false, error: 'no config' });
  });

  test('a provider with no model list says so', async () => {
    const result = await listProviderModels({ id: 'plain', displayName: 'plain' });
    assert.equal(result.ok, false);
  });
});
