/**
 * @fileoverview E2E tests: collapsing parts of the layout so the messages
 * get their space back — the bars above the message list (topbar, search
 * bar, agent-filter bar, page navigation), the chat list, and the agent
 * panel. See COLLAPSIBLE_PARTS in app.js.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import { launchBrowser, closeBrowser, openPage, closePage, tid, createChat, reloadAndWaitForConnection } from '../helpers/browser.js';

describe('Collapsible panels', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    await startServer();
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
    // localStorage outlives a page, so start every test expanded.
    await page.evaluate(() => {
      for (const key of ['chatHeaderCollapsed', 'sidebarCollapsed', 'agentPanelCollapsed']) localStorage.removeItem(key);
    });
    await reloadAndWaitForConnection(page);
    await createChat(page, 'Header Test');
  });

  // checkVisibility, not the element's own display: a hidden ancestor
  // (the topbar) doesn't change its children's computed display.
  const isShown = (testId) => page.$eval(tid(testId), (el) => el.checkVisibility());

  test('collapsing hides the topbar and gives its space to the messages, and expanding brings it back', async () => {
    const listTopBefore = await page.$eval(tid('message-list'), (el) => el.getBoundingClientRect().top);
    await page.click(tid('chat-header-collapse-btn'));

    assert.equal(await isShown('chat-topbar-name'), false);
    assert.equal(await isShown('chat-header-expand-btn'), true);
    const listTopAfter = await page.$eval(tid('message-list'), (el) => el.getBoundingClientRect().top);
    assert.ok(listTopAfter < listTopBefore, `message list should move up: ${listTopBefore} → ${listTopAfter}`);

    await page.click(tid('chat-header-expand-btn'));
    assert.equal(await isShown('chat-topbar-name'), true);
    assert.equal(await isShown('chat-header-expand-btn'), false);
  });

  test('the collapsed state survives a reload', async () => {
    await page.click(tid('chat-header-collapse-btn'));
    await reloadAndWaitForConnection(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.chatHeader), 'collapsed');
    assert.equal(await isShown('chat-header-expand-btn'), true);
  });

  test('the expand button is marked while a hidden bar has something in effect, like an open search', async () => {
    await page.click(tid('search-btn'));
    await page.click(tid('chat-header-collapse-btn'));
    const marked = () => page.$eval(tid('chat-header-expand-btn'), (el) => el.classList.contains('has-hidden-state'));
    assert.equal(await marked(), true);

    await page.click(tid('chat-header-expand-btn'));
    await page.click(tid('search-close'));
    assert.equal(await marked(), false);
  });

  test('the chat list and the agent panel collapse to edge strips, give their width to the chat, and come back', async () => {
    const chatWidth = () => page.$eval('#chat-area', (el) => el.getBoundingClientRect().width);
    const before = await chatWidth();
    await page.click(tid('sidebar-collapse-btn'));
    await page.click(tid('agent-panel-collapse-btn'));

    assert.equal(await isShown('chat-list'), false);
    assert.equal(await isShown('agent-list') || await isShown('no-chat-notice') || await isShown('new-agent-btn'), false);
    assert.equal(await isShown('sidebar-expand-btn'), true);
    assert.equal(await isShown('agent-panel-expand-btn'), true);
    assert.ok(await chatWidth() > before + 300, 'the chat should take the width both panels gave up');

    await reloadAndWaitForConnection(page);
    assert.equal(await isShown('chat-list'), false, 'stays collapsed across a reload');

    await page.click(tid('sidebar-expand-btn'));
    await page.click(tid('agent-panel-expand-btn'));
    assert.equal(await isShown('chat-list'), true);
    assert.equal(await isShown('new-agent-btn'), true);
    assert.equal(await isShown('sidebar-expand-btn'), false);
  });

  test('on a narrow window the panels stay drawers, whatever was collapsed on a wide one', async () => {
    await page.click(tid('sidebar-collapse-btn'));
    await page.setViewport({ width: 600, height: 800 });
    try {
      assert.equal(await isShown('sidebar-expand-btn'), false, 'no edge strip: the ☰ drawer toggle covers it');
      assert.equal(await isShown('sidebar-toggle-btn'), true);
    } finally {
      await page.setViewport({ width: 1280, height: 800 });
    }
  });
});
