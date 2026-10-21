/**
 * @fileoverview E2E tests: choosing an agent's provider in the New Agent
 * form, and the UI going by that provider afterwards. No model is ever
 * called: OPENCODE_BIN is /bin/true, so creating an opencode agent passes
 * the binary check without a real opencode install.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import { launchBrowser, closeBrowser, openPage, closePage, tid, createChat, createAgent } from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Opens the New Agent modal and waits for it.
 * @param {import('puppeteer').Page} page
 */
async function openNewAgentModal(page) {
  await page.click(tid('new-agent-btn'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="modal-overlay"]')?.hidden, { timeout: 3000 });
}

/**
 * Waits until the provider picker reflects the server's availability check.
 * @param {import('puppeteer').Page} page
 */
function waitForProviderCheck(page) {
  return page.waitForFunction(
    () => {
      const status = document.querySelector('[data-testid="agent-provider-status"]')?.textContent ?? '';
      return status && !/Checking/.test(status);
    },
    { timeout: 5000 },
  );
}

/**
 * Whether an element is rendered (no `hidden` on it or an ancestor).
 * @param {import('puppeteer').Page} page
 * @param {string} selector
 * @returns {Promise<boolean>}
 */
function isShown(page, selector) {
  return page.$eval(selector, (el) => !el.closest('[hidden]'));
}

describe('Agent providers', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    await startServer({ OPENCODE_BIN: '/bin/true' });
    await launchBrowser();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
  });

  beforeEach(async () => {
    await resetData();
    if (page) await closePage();
    page = await openPage();
    await createChat(page, 'Provider Chat');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('the form offers every provider, Claude first, with Claude-only options shown', async () => {
    await openNewAgentModal(page);
    const options = await page.$$eval(`${tid('agent-provider-select')} option`, (els) => els.map((el) => el.value));
    assert.deepEqual(options, ['claude', 'opencode']);
    assert.equal(await page.$eval(tid('agent-provider-select'), (el) => el.value), 'claude');
    assert.equal(await isShown(page, tid('agent-model-select')), true);
    assert.equal(await isShown(page, tid('agent-autocompact-input')), true);
    assert.equal(await isShown(page, tid('chrome-access-check')), true);
  });

  test('picking opencode fits the form to it', async () => {
    await openNewAgentModal(page);
    await page.click(tid('agent-name-generate'));
    const claudeName = await page.$eval(tid('agent-name-input'), (el) => el.value);
    await page.select(tid('agent-provider-select'), 'opencode');

    // No model families, just an exact ID; no compaction window or browser access.
    assert.equal(await isShown(page, tid('agent-model-select')), false);
    assert.equal(await isShown(page, tid('agent-model-custom-input')), true);
    assert.match(await page.$eval(tid('agent-model-custom-input'), (el) => el.placeholder), /ollama\/local-agent/);
    assert.equal(await isShown(page, tid('agent-autocompact-input')), false);
    assert.equal(await isShown(page, tid('chrome-access-check')), false);
    assert.match(await page.$eval('#agent-resume-hint', (el) => el.textContent), /opencode --session/);
    // A name generated for Claude is swapped for one from opencode's pool.
    const name = await page.$eval(tid('agent-name-input'), (el) => el.value);
    assert.notEqual(name, claudeName);

    await page.select(tid('agent-provider-select'), 'claude');
    assert.equal(await isShown(page, tid('agent-model-select')), true);
    assert.equal(await isShown(page, tid('agent-autocompact-input')), true);
  });

  test('an opencode agent is stored as one and shown with its badge and its own menu', async () => {
    await createAgent(page, { name: 'Opal', workingDir: agentDir('opal'), provider: 'opencode' });
    await page.waitForSelector(tid('agent-item'), { timeout: 5000 });

    const agents = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].provider, 'opencode');

    assert.ok(await page.$(tid('agent-provider-badge')), 'opencode agent shows a provider badge');
    // Compaction is Claude's, so its menu item isn't offered.
    assert.equal(await page.$(tid('agent-autocompact-btn')), null);
    assert.ok(await page.$(tid('agent-model-btn')));
  });

  test('a Claude agent looks exactly as before: no provider badge', async () => {
    await createAgent(page, { name: 'Clara', workingDir: agentDir('clara') });
    await page.waitForSelector(tid('agent-item'), { timeout: 5000 });
    assert.equal(await page.$(tid('agent-provider-badge')), null);
    assert.ok(await page.$(tid('agent-autocompact-btn')));
  });

  test('switching an opencode agent\'s model asks for an exact ID only', async () => {
    await createAgent(page, { name: 'Opal', workingDir: agentDir('opal'), provider: 'opencode' });
    await page.waitForSelector(tid('agent-item'), { timeout: 5000 });
    await page.click(tid('agent-menu-btn'));
    await page.click(tid('agent-model-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="confirm-model-row"]')?.hidden, { timeout: 3000 });
    assert.equal(await isShown(page, tid('confirm-model-select')), false);
    assert.equal(await isShown(page, tid('confirm-model-custom-input')), true);

    await page.type(tid('confirm-model-custom-input'), 'ollama/local-agent');
    await page.click(tid('confirm-ok'));
    await page.waitForFunction(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/agents`);
      const [agent] = await res.json();
      return agent?.modelOverride === 'ollama/local-agent';
    }, { timeout: 5000 }, TEST_PORT);
  });
});

describe('Agent providers that are not installed', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    // '' rather than a path: no override, so opencode is looked for in the
    // project, on PATH and in ~/.opencode/bin like on a real machine. A
    // PATH without it (just node's own directory, which the server needs,
    // and the system's) keeps the result the same wherever this runs.
    await startServer({ OPENCODE_BIN: '', HOME: '/nonexistent-home', PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
    await launchBrowser();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
  });

  beforeEach(async () => {
    await resetData();
    if (page) await closePage();
    page = await openPage();
    await createChat(page, 'Provider Chat');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('a provider that can\'t be found is offered disabled, with how to install it', async () => {
    await openNewAgentModal(page);
    await waitForProviderCheck(page);
    const options = await page.$$eval(`${tid('agent-provider-select')} option`, (els) => els.map((el) => ({ value: el.value, disabled: el.disabled, text: el.textContent })));
    const opencode = options.find((o) => o.value === 'opencode');
    assert.equal(opencode.disabled, true);
    assert.match(opencode.text, /not found/);
    assert.match(await page.$eval(tid('agent-provider-status'), (el) => el.textContent), /opencode wasn't found/);
  });

  test('a project that pins its own opencode makes it available for that working directory', async () => {
    const dir = agentDir('pinned');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'opencode'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });

    await openNewAgentModal(page);
    await waitForProviderCheck(page);
    await page.type(tid('agent-dir-input'), dir);
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="agent-provider-select"] option[value="opencode"]')?.disabled,
      { timeout: 5000 },
    );
    await page.select(tid('agent-provider-select'), 'opencode');
    assert.match(await page.$eval(tid('agent-provider-status'), (el) => el.textContent), /opencode 9\.9\.9 · pinned by this project/);
  });
});

describe('Picking an opencode model from its list', () => {
  /** @type {import('puppeteer').Page} */
  let page;
  /** Holds the fake opencode, which lists two models, plus one more in a project with its own opencode.json. */
  const binDir = mkdtempSync(join(tmpdir(), 'agentwaggle-e2e-fake-opencode-'));

  before(async () => {
    const bin = join(binDir, 'opencode');
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = models ]; then',
      '  printf "ollama/local-agent\\nopencode/big-pickle\\n"',
      '  [ -f opencode.json ] && echo project/own-model',
      'fi',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    await startServer({ OPENCODE_BIN: bin });
    await launchBrowser();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
    rmSync(binDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetData();
    if (page) await closePage();
    page = await openPage();
    await createChat(page, 'Provider Chat');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  /**
   * The model picker's offered option values, once it lists at least `count` models.
   * @param {string} selectId
   * @param {number} count
   * @returns {Promise<string[]>}
   */
  async function listedModels(selectId, count) {
    await page.waitForFunction(
      (selector, n) => document.querySelectorAll(`${selector} option[data-listed]`).length >= n,
      { timeout: 5000 },
      tid(selectId),
      count,
    );
    return page.$$eval(`${tid(selectId)} option`, (els) => els.filter((el) => !el.hidden).map((el) => el.value));
  }

  test('the New Agent form lists the project\'s models, and the pick is stored', async () => {
    const dir = agentDir('listed');
    writeFileSync(join(dir, 'opencode.json'), '{}');
    await openNewAgentModal(page);
    await page.select(tid('agent-provider-select'), 'opencode');
    await page.type(tid('agent-name-input'), 'Opal');
    await page.type(tid('agent-dir-input'), dir);

    assert.deepEqual(await listedModels('agent-model-select', 3), ['', 'ollama/local-agent', 'opencode/big-pickle', 'project/own-model', 'custom']);
    assert.equal(await isShown(page, tid('agent-model-custom-input')), false);
    assert.match(await page.$eval(`${tid('agent-model-select')} option[value=""]`, (el) => el.textContent), /let opencode choose/);

    await page.select(tid('agent-model-select'), 'project/own-model');
    await page.click(tid('modal-submit'));
    await page.waitForFunction(async (port) => {
      const [agent] = await (await fetch(`http://localhost:${port}/api/agents`)).json();
      return agent?.modelOverride === 'project/own-model';
    }, { timeout: 5000 }, TEST_PORT);
  });

  test('switching an opencode agent\'s model offers its list, with its current model picked', async () => {
    await createAgent(page, { name: 'Opal', workingDir: agentDir('opal'), provider: 'opencode' });
    await page.waitForSelector(tid('agent-item'), { timeout: 5000 });
    await fetch(`http://localhost:${TEST_PORT}/api/agents/${(await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json())[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelOverride: 'opencode/big-pickle' }),
    });
    await page.reload();
    await page.waitForSelector(tid('agent-item'), { timeout: 5000 });

    await page.click(tid('agent-menu-btn'));
    await page.click(tid('agent-model-btn'));
    assert.deepEqual(await listedModels('confirm-model-select', 2), ['', 'ollama/local-agent', 'opencode/big-pickle', 'custom']);
    assert.equal(await page.$eval(tid('confirm-model-select'), (el) => el.value), 'opencode/big-pickle');

    await page.select(tid('confirm-model-select'), 'ollama/local-agent');
    await page.click(tid('confirm-ok'));
    await page.waitForFunction(async (port) => {
      const [agent] = await (await fetch(`http://localhost:${port}/api/agents`)).json();
      return agent?.modelOverride === 'ollama/local-agent';
    }, { timeout: 5000 }, TEST_PORT);
  });
});
