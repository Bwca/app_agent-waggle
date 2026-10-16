/**
 * @fileoverview Unit tests for nameGeneratorFor (server/public/
 * agentProviders.js) — default-name selection for a new agent, chosen by
 * the agent's provider.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER_ID, nameGeneratorFor } from '../../server/public/agentProviders.js';
import { getProvider } from '../../server/services/providers/index.js';

describe('nameGeneratorFor', () => {
  test('every registered server provider has a name pool', () => {
    assert.doesNotThrow(() => nameGeneratorFor(getProvider(DEFAULT_PROVIDER_ID).id));
  });

  test('defaults to the default provider', () => {
    assert.equal(nameGeneratorFor()([], () => 0), nameGeneratorFor(DEFAULT_PROVIDER_ID)([], () => 0));
  });

  test('an unknown provider fails loudly instead of borrowing another pool', () => {
    assert.throws(() => nameGeneratorFor('nope'), /No default names for agent provider: nope/);
  });

  test('skips names already taken, case-insensitively', () => {
    const generate = nameGeneratorFor('claude');
    const first = generate([], () => 0);
    assert.notEqual(generate([first.toUpperCase()], () => 0).toLowerCase(), first.toLowerCase());
  });

  test('numbers a name once the whole pool is taken', () => {
    const generate = nameGeneratorFor('claude');
    const pool = [];
    for (let name = generate(pool, () => 0); !/ \d+$/.test(name); name = generate(pool, () => 0)) pool.push(name);
    const base = generate([], () => 0);
    assert.equal(generate(pool, () => 0), `${base} 2`);
    assert.equal(generate([...pool, `${base} 2`], () => 0), `${base} 3`);
  });
});
