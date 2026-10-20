/**
 * @fileoverview Puppeteer browser/page lifecycle and selector helpers.
 * All selectors use data-testid attributes.
 */

import puppeteer from 'puppeteer';
import { TEST_PORT } from './server.js';

const APP_URL = `http://localhost:${TEST_PORT}`;

/** @type {import('puppeteer').Browser | null} */
let browser = null;

/** @type {import('puppeteer').Page | null} */
let page = null;

/**
 * Launches a headless Chromium instance.
 *
 * Pins a real-desktop-sized default viewport, rather than leaving it at
 * Puppeteer's own default (800x600) — style.css's responsive breakpoints
 * (see its "Responsive layout" section) turn the sidebar/agent panel into
 * off-canvas drawers below 640/900px, so an unpinned 800x600 default would
 * silently run every test's clicks against the narrow, drawer-collapsed
 * layout instead of the normal desktop one most of this suite assumes.
 * @returns {Promise<void>}
 */
export async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

/**
 * Closes the browser instance.
 * @returns {Promise<void>}
 */
export async function closeBrowser() {
  await browser?.close();
  browser = null;
  page = null;
}

/**
 * Opens a fresh page and navigates to the app.
 * Waits until the WebSocket connection indicator turns green.
 * @returns {Promise<import('puppeteer').Page>}
 */
export async function openPage() {
  page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'networkidle0' });
  // Wait for WS to connect (conn-dot gains .connected class)
  await page.waitForFunction(
    () => document.querySelector('[data-testid="conn-dot"]')?.classList.contains('connected'),
    { timeout: 8000 }
  );
  return page;
}

/**
 * Reloads the current page (e.g. to test that state persists via the URL)
 * and waits for the WebSocket to reconnect, same as {@link openPage}.
 * @param {import('puppeteer').Page} p
 * @returns {Promise<void>}
 */
export async function reloadAndWaitForConnection(p) {
  await p.reload({ waitUntil: 'networkidle0' });
  await p.waitForFunction(
    () => document.querySelector('[data-testid="conn-dot"]')?.classList.contains('connected'),
    { timeout: 8000 }
  );
}

/**
 * Closes the current page.
 * @returns {Promise<void>}
 */
export async function closePage() {
  await page?.close();
  page = null;
}

/**
 * Returns a CSS attribute selector string for a data-testid.
 * @param {string} testId
 * @returns {string}
 */
export function tid(testId) {
  return `[data-testid="${testId}"]`;
}

// ─── Action helpers ──────────────────────────────────────────────────────────

/**
 * Creates a new chat by clicking the + button and typing a name.
 * @param {import('puppeteer').Page} p
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function createChat(p, name) {
  await p.click(tid('new-chat-btn'));
  // Wait for the form to become visible (hidden attr removed by JS)
  await p.waitForFunction(
    () => {
      const form = document.querySelector('#new-chat-form');
      return form && !form.hidden;
    },
    { timeout: 3000 }
  );
  await p.type(tid('new-chat-input'), name);
  await p.keyboard.press('Enter');
  // Wait for chat to appear in the sidebar
  await p.waitForFunction(
    (n) => [...document.querySelectorAll('[data-testid="chat-item-name"]')]
      .some((el) => el.textContent.includes(n)),
    { timeout: 3000 },
    name
  );
}

/**
 * Opens the "New Agent" modal and fills in the form.
 * @param {import('puppeteer').Page} p
 * `provider` picks the agent's provider in the form; the default otherwise.
 * @param {{ name: string, workingDir: string, provider?: string, addToChat?: boolean, yoloMode?: boolean, observerMode?: boolean, note?: string }} opts
 * @returns {Promise<void>}
 */
export async function createAgent(p, { name, workingDir, provider, addToChat = true, yoloMode = false, observerMode = false, note }) {
  await p.click(tid('new-agent-btn'));
  // Wait for modal to appear (hidden attr removed)
  await p.waitForFunction(
    () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
    { timeout: 3000 }
  );
  if (provider) await p.select(tid('agent-provider-select'), provider);
  await p.type(tid('agent-name-input'), name);
  await p.type(tid('agent-dir-input'), workingDir);
  if (note) await p.type(tid('agent-note-input'), note);

  // Toggle "Add to current chat" checkbox if needed
  const checked = await p.$eval(tid('add-to-chat-check'), (el) => el.checked);
  if (checked !== addToChat) await p.click(tid('add-to-chat-check'));

  if (yoloMode) await p.click(tid('yolo-mode-check'));
  if (observerMode) await p.click(tid('observer-mode-check'));

  await p.click(tid('modal-submit'));
  // Wait for modal to close
  await p.waitForFunction(
    () => document.querySelector('[data-testid="modal-overlay"]')?.hidden,
    { timeout: 5000 }
  );
}

/**
 * Sends a message in the active chat.
 * @param {import('puppeteer').Page} p
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function sendMessage(p, content) {
  await p.click(tid('msg-input'));
  await p.type(tid('msg-input'), content);
  await p.keyboard.press('Enter');
}

/**
 * Simulates pasting an image into the message input by dispatching a
 * synthetic ClipboardEvent (Puppeteer can't drive the real OS clipboard).
 * @param {import('puppeteer').Page} p
 * @param {string} base64Data - Raw base64 image bytes (no data: prefix)
 * @param {string} [mediaType]
 * @returns {Promise<void>}
 */
export async function pasteImage(p, base64Data, mediaType = 'image/png') {
  await p.evaluate(({ base64Data, mediaType }) => {
    const byteChars = atob(base64Data);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const file = new File([bytes], 'pasted.png', { type: mediaType });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('[data-testid="msg-input"]');
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { base64Data, mediaType });
}

/**
 * Simulates pasting plain text into the message input via a synthetic
 * ClipboardEvent, so the app's paste handler (not raw typing) processes it.
 * @param {import('puppeteer').Page} p
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function pasteText(p, text) {
  await p.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const input = document.querySelector('[data-testid="msg-input"]');
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

/**
 * Switches the UI language via the Settings modal.
 * @param {import('puppeteer').Page} p
 * @param {string} locale - e.g. "en-CA" or "fr-CA"
 * @returns {Promise<void>}
 */
export async function setLanguage(p, locale) {
  await p.click(tid('settings-btn'));
  await p.waitForFunction(
    () => !document.querySelector('[data-testid="settings-overlay"]')?.hidden,
    { timeout: 3000 }
  );
  await p.select(tid('settings-language-select'), locale);
  await p.click(tid('settings-save'));
  await p.waitForFunction(
    () => document.querySelector('[data-testid="settings-overlay"]')?.hidden,
    { timeout: 3000 }
  );
}

/**
 * Waits for a streaming bubble to appear and fully resolve into a message.
 * @param {import('puppeteer').Page} p
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<string>} The final message text
 */
export async function waitForAgentResponse(p, { timeout = 60_000 } = {}) {
  // Wait for streaming bubble to appear
  await p.waitForFunction(
    () => document.querySelector('[data-testid="streaming-bubble"]') !== null,
    { timeout }
  );
  // Wait for it to disappear (stream ended → replaced by static message)
  await p.waitForFunction(
    () => document.querySelector('[data-testid="streaming-bubble"]') === null,
    { timeout }
  );
  // Return text of the last agent message
  const messages = await p.$$(tid('message') + '[data-role="agent"]');
  const last = messages[messages.length - 1];
  return last?.$eval(tid('msg-content'), (el) => el.textContent) ?? '';
}
