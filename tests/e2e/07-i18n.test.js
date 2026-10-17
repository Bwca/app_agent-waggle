/**
 * @fileoverview E2E tests: i18n (Canadian English / Canadian French).
 * Assertions check against the REAL dictionaries rather than hardcoded
 * translated copy, so tests cross-check the actual shipped strings and
 * don't go stale if wording is tweaked later.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage, tid,
  createChat, sendMessage, pasteText, setLanguage,
} from '../helpers/browser.js';
import enCA from '../../server/public/i18n/en-CA.js';
import frCA from '../../server/public/i18n/fr-CA.js';

describe('i18n', () => {
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
  });

  test('defaults to en-CA on first load', async () => {
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    assert.equal(htmlLang, 'en-CA');

    const headerText = await page.$eval('#agent-panel-title', (el) => el.textContent);
    assert.equal(headerText, enCA['agentPanel.header']);

    const newChatTitle = await page.$eval(tid('new-chat-btn'), (el) => el.title);
    assert.equal(newChatTitle, enCA['sidebar.newChatTitle']);
  });

  test('settings modal exposes the language selector, matching GET /api/settings', async () => {
    const settingsRes = await fetch(`http://localhost:${TEST_PORT}/api/settings`);
    const settings = await settingsRes.json();
    assert.equal(settings.locale, 'en-CA');

    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const selectValue = await page.$eval(tid('settings-language-select'), (el) => el.value);
    assert.equal(selectValue, settings.locale);
  });

  test('switching to French updates already-rendered static chrome instantly, no reload', async () => {
    await createChat(page, 'Discussion Test');

    await setLanguage(page, 'fr-CA');

    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    assert.equal(htmlLang, 'fr-CA');

    const headerText = await page.$eval('#agent-panel-title', (el) => el.textContent);
    assert.equal(headerText, frCA['agentPanel.header']);

    const newChatTitle = await page.$eval(tid('new-chat-btn'), (el) => el.title);
    assert.equal(newChatTitle, frCA['sidebar.newChatTitle']);

    const chatItemName = await page.$eval(tid('chat-item-name'), (el) => el.textContent);
    assert.equal(chatItemName, frCA['chat.channelName'].replace('{name}', 'Discussion Test'));
  });

  test('switching language reformats an already-rendered timestamp', async () => {
    await createChat(page, 'Time Test');
    await sendMessage(page, 'hello');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );
    const iso = await page.$eval('.msg-time', (el) => el.dataset.iso);

    await setLanguage(page, 'fr-CA');

    const timeText = await page.$eval('.msg-time', (el) => el.textContent);
    const expected = await page.evaluate(
      (iso) => new Date(iso).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }),
      iso
    );
    assert.equal(timeText, expected);
  });

  test('a timestamp from a previous day includes the date, not just the time', async () => {
    await createChat(page, 'Old Timestamp Test');
    await sendMessage(page, 'hello');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    // fmtTime is a module-private function, not reachable directly from
    // page.evaluate — backdating the rendered element's data-iso and then
    // triggering a locale switch (the only thing that currently re-runs
    // the real fmtTime against .msg-time[data-iso] elements) exercises the
    // actual code path instead of reimplementing it.
    const backdatedIso = await page.evaluate(() => {
      const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      document.querySelector('.msg-time').dataset.iso = iso;
      return iso;
    });

    await setLanguage(page, 'fr-CA');

    const timeText = await page.$eval('.msg-time', (el) => el.textContent);
    const expected = await page.evaluate((iso) => {
      const date = new Date(iso);
      const now = new Date();
      const includeYear = date.getFullYear() !== now.getFullYear();
      return date.toLocaleString('fr-CA', {
        month: 'short',
        day: 'numeric',
        ...(includeYear ? { year: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
      });
    }, backdatedIso);
    assert.equal(timeText, expected);
  });

  test('a server error renders in the selected language', async () => {
    await setLanguage(page, 'fr-CA');

    const res = await fetch(`http://localhost:${TEST_PORT}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, frCA['errors.chatNameRequired']);
  });

  test('delete confirmation dialogs are localized, including the interpolated name', async () => {
    await createChat(page, 'Discussion Test');
    await setLanguage(page, 'fr-CA');

    const chatItem = await page.$(tid('chat-item'));
    await chatItem.hover();
    await page.click(tid('chat-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const confirmText = await page.$eval(tid('confirm-message'), (el) => el.textContent);
    assert.equal(confirmText, frCA['confirm.deleteChat'].replace('{name}', 'Discussion Test'));
  });

  test('pluralization is correct in French for both singular and plural paste counts', async () => {
    await createChat(page, 'Plural Test');

    await setLanguage(page, 'fr-CA');

    // Plural: many lines.
    await pasteText(page, Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="attachment-chip"] .attachment-chip-label') !== null,
      { timeout: 3000 }
    );
    const pluralLabel = await page.$eval(
      '[data-testid="attachment-chip"] .attachment-chip-label',
      (el) => el.textContent
    );
    assert.match(pluralLabel, /\+25 lignes\)$/);

    // Singular: one long line (qualifies as an attachment via the char
    // threshold, not the line-count threshold, so it's exactly 1 "line").
    await pasteText(page, 'x'.repeat(900));
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="attachment-chip"] .attachment-chip-label')]
        .some((el) => el.textContent.includes('nº2')),
      { timeout: 3000 }
    );
    const labels = await page.$$eval(
      '[data-testid="attachment-chip"] .attachment-chip-label',
      (els) => els.map((el) => el.textContent)
    );
    const singularLabel = labels.find((label) => label.includes('nº2'));
    assert.match(singularLabel, /\+1 ligne\)$/);
  });

  test('language persists across a reload', async () => {
    await setLanguage(page, 'fr-CA');
    await closePage();
    page = await openPage();

    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    assert.equal(htmlLang, 'fr-CA');

    await page.click(tid('settings-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const selectValue = await page.$eval(tid('settings-language-select'), (el) => el.value);
    assert.equal(selectValue, 'fr-CA');
  });

  test('a pasted-text attachment label reflects the locale active at paste time, not the current one', async () => {
    await createChat(page, 'Historical Label Test');

    // Pasted while in en-CA.
    await pasteText(page, Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="attachment-chip"] .attachment-chip-label') !== null,
      { timeout: 3000 }
    );
    await sendMessage(page, 'first message');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    await setLanguage(page, 'fr-CA');

    // A new paste after switching to fr-CA.
    await pasteText(page, Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="attachment-chip"] .attachment-chip-label') !== null,
      { timeout: 3000 }
    );
    await sendMessage(page, 'second message');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 1,
      { timeout: 5000 }
    );

    // Reload — a chat switch/reload re-fetches history fresh from the server.
    await closePage();
    page = await openPage();
    await page.click(tid('chat-item'));
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="msg-attachment-text"]').length > 1,
      { timeout: 5000 }
    );

    const labels = await page.$$eval(
      '[data-testid="msg-attachment-text"] summary',
      (els) => els.map((el) => el.textContent)
    );
    assert.equal(labels.length, 2);
    assert.match(labels[0], /lines\)$/, 'the message sent while in en-CA should keep its English label forever');
    assert.match(labels[1], /lignes\)$/, 'the message sent after switching to fr-CA should have a French label');
  });
});
