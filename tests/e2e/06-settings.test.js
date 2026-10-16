/**
 * @fileoverview E2E tests: user settings (display name, message color, theme,
 * and the default context-compaction window).
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import { launchBrowser, closeBrowser, openPage, closePage, tid, createChat, createAgent, sendMessage, reloadAndWaitForConnection } from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Settings', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    await startServer();
    await launchBrowser();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
    cleanupAgentDirs();
  });

  beforeEach(async () => {
    await resetData();
    if (page) await closePage();
    page = await openPage();
  });

  test('user messages default to "You" as the author', async () => {
    await createChat(page, 'Default Name Test');
    await sendMessage(page, 'hello');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="message"]') !== null,
      { timeout: 5000 }
    );
    const author = await page.$eval(tid('msg-author'), (el) => el.textContent.trim());
    assert.equal(author, 'You');
  });

  test('settings modal pre-fills with the current display name', async () => {
    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const value = await page.$eval(tid('settings-display-name-input'), (el) => el.value);
    assert.equal(value, 'You');
  });

  test('changing the display name applies retroactively to past messages, not just future ones', async () => {
    await createChat(page, 'Rename Test');
    await sendMessage(page, 'before rename');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.evaluate(() => { document.querySelector('[data-testid="settings-display-name-input"]').value = ''; });
    await page.type(tid('settings-display-name-input'), 'Volodymyr');
    await page.click(tid('settings-save'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    // The already-rendered "before rename" message should update immediately,
    // without needing a reload or chat switch.
    const authorRightAfterSave = await page.$eval(tid('msg-author'), (el) => el.textContent.trim());
    assert.equal(authorRightAfterSave, 'Volodymyr', 'already-visible messages should update immediately after saving');

    await sendMessage(page, 'after rename');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 1,
      { timeout: 5000 }
    );
    const authorsLive = await page.$$eval(tid('msg-author'), (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(authorsLive, ['Volodymyr', 'Volodymyr']);

    // Confirm it's a real server-side resolution, not just a client-side
    // patch, by re-fetching history fresh (as a chat switch/reload would).
    const chats = await (await fetch(`http://localhost:${TEST_PORT}/api/chats`)).json();
    const chat = chats.find((c) => c.name === 'Rename Test');
    const msgs = await (await fetch(`http://localhost:${TEST_PORT}/api/chats/${chat.id}/messages`)).json();
    const userAuthorNames = msgs.filter((m) => m.role === 'user').map((m) => m.authorName);
    assert.deepEqual(userAuthorNames, ['Volodymyr', 'Volodymyr']);
  });

  test('canceling the settings modal does not change the display name', async () => {
    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.evaluate(() => { document.querySelector('[data-testid="settings-display-name-input"]').value = ''; });
    await page.type(tid('settings-display-name-input'), 'Should Not Save');
    await page.click(tid('settings-cancel'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`);
    const settings = await res.json();
    assert.equal(settings.userDisplayName, 'You', 'canceling should leave the display name unchanged');
  });

  test('PUT /api/settings rejects an empty display name', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  test('user messages default to a preset gray message color', async () => {
    await createChat(page, 'Default Color Test');
    await sendMessage(page, 'hello');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="message"]') !== null,
      { timeout: 5000 }
    );
    const color = await page.$eval(
      tid('message'),
      (el) => getComputedStyle(el).getPropertyValue('--author-color').trim()
    );
    assert.equal(color, '#a6adc8');
  });

  test('changing the message color applies instantly and retroactively', async () => {
    await createChat(page, 'Recolor Test');
    await sendMessage(page, 'before recolor');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const swatches = await page.$$(tid('settings-color-grid') + ' .color-swatch');
    const targetColor = await swatches[1].evaluate((el) => el.title);
    await swatches[1].click();
    await page.click(tid('settings-save'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    // Already-rendered message updates immediately.
    const colorRightAfterSave = await page.$eval(
      tid('message'),
      (el) => getComputedStyle(el).getPropertyValue('--author-color').trim()
    );
    assert.equal(colorRightAfterSave.toLowerCase(), targetColor.toLowerCase());

    // A brand new message uses it too.
    await sendMessage(page, 'after recolor');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 1,
      { timeout: 5000 }
    );
    const colors = await page.$$eval(
      tid('message'),
      (els) => els.map((el) => getComputedStyle(el).getPropertyValue('--author-color').trim())
    );
    assert.ok(colors.every((c) => c.toLowerCase() === targetColor.toLowerCase()));

    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`);
    const settings = await res.json();
    assert.equal(settings.userColor.toLowerCase(), targetColor.toLowerCase());

    // Re-opening settings reflects the saved color as selected.
    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const selectedSwatch = await page.$eval(
      tid('settings-color-grid') + ' .color-swatch.selected',
      (el) => el.title
    );
    assert.equal(selectedSwatch.toLowerCase(), targetColor.toLowerCase());
  });

  test('PUT /api/settings rejects an invalid color', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName: 'You', userColor: 'not-a-color' }),
    });
    assert.equal(res.status, 400);
  });

  test('defaults to dark theme, with no data-theme attribute on <html>', async () => {
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(theme, undefined, 'dark is the attribute-less default — see applyTheme in app.js');

    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`);
    const settings = await res.json();
    assert.equal(settings.theme, 'dark');
  });

  test('switching to light theme applies immediately, persists server-side, and survives a reload', async () => {
    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.select(tid('settings-theme-select'), 'light');
    await page.click(tid('settings-save'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const themeRightAfterSave = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(themeRightAfterSave, 'light', 'should apply immediately, without needing a reload');

    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`);
    const settings = await res.json();
    assert.equal(settings.theme, 'light');

    // The inline no-FOUC snippet in index.html's <head> reads localStorage,
    // not a fetch — confirms that fast path actually works, not just the
    // eventual /api/settings-driven correction in init().
    await reloadAndWaitForConnection(page);
    const themeAfterReload = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(themeAfterReload, 'light', 'should survive a reload via the localStorage fast path');
  });

  test('the default compaction window is set in Settings, and an existing agent can override it from its menu', async () => {
    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.type(tid('settings-autocompact-input'), '300K');
    await page.click(tid('settings-save'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const settings = await (await fetch(`http://localhost:${TEST_PORT}/api/settings`)).json();
    assert.equal(settings.defaultAutocompact, '300k', 'saved in canonical form');

    await createChat(page, 'Compaction Test');
    await createAgent(page, { name: 'Ada', workingDir: agentDir('compaction') });
    const menuLabel = () => page.$eval(tid('agent-autocompact-btn'), (el) => el.textContent.trim());
    assert.match(await menuLabel(), /default \(300k\)/);

    await page.click(tid('agent-menu-btn'));
    await page.click(tid('agent-autocompact-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="confirm-text-row"]')?.hidden, { timeout: 3000 });
    await page.type(tid('confirm-text-input'), '400k');
    await page.click(tid('confirm-ok'));
    await page.waitForFunction(
      () => /: 400k$/.test(document.querySelector('[data-testid="agent-autocompact-btn"]')?.textContent.trim() ?? ''),
      { timeout: 5000 }
    );
    const [agent] = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    assert.equal(agent.autocompactOverride, '400k');
  });

  test('PUT /api/settings rejects a compaction window the CLI would refuse', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName: 'You', defaultAutocompact: '2M' }),
    });
    assert.equal(res.status, 400);
  });

  test('PUT /api/settings rejects an invalid theme', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName: 'You', theme: 'not-a-theme' }),
    });
    assert.equal(res.status, 400);
  });
});
