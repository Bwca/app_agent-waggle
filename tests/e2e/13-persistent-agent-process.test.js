/**
 * @fileoverview E2E tests: agents run as one persistent `claude` process for
 * as long as they're in a chat, instead of a fresh one-shot process per
 * turn. Real subprocess only — no mocking — so persistence, teardown, and
 * shutdown are all verified against the actual OS process, via `ps`, not
 * just trusted from the UI. This is what lets MCP servers (and anything
 * else expensive to establish) survive across turns instead of being torn
 * down and reconnected on every single message.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

/**
 * Counts live `claude` CLI processes whose args mention `workingDir` (every
 * spawn passes it via `--add-dir`) — a real, external, black-box signal
 * that's impossible to observe under the old one-shot-per-turn model,
 * where no `claude` process is ever still alive once a turn's reply has
 * arrived.
 * @param {string} workingDir
 * @returns {number}
 */
function liveClaudeProcessCount(workingDir) {
  let out;
  try {
    out = execSync('ps -eo args', { encoding: 'utf-8' });
  } catch {
    return 0;
  }
  return out.split('\n').filter((line) => line.includes('claude') && line.includes('--print') && line.includes(workingDir)).length;
}

/**
 * Polls until liveClaudeProcessCount(workingDir) matches `expected`.
 * @param {string} workingDir
 * @param {number} expected
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForProcessCount(workingDir, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = liveClaudeProcessCount(workingDir);
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`expected ${expected} live claude process(es) for ${workingDir}, got ${last}`);
}

describe('Persistent agent processes', () => {
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

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('adding an agent to a chat spawns its process before any message is sent', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Eager Spawn Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // No message sent at all yet — this is only possible to observe as
    // "already running" under the new architecture.
    await waitForProcessCount(dir, 1);
  });

  test('the same process handles multiple turns and genuinely remembers between them', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Persistence Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });
    await waitForProcessCount(dir, 1);

    await sendMessage(page, 'Remember this word: papaya. Reply with exactly: ok');
    await waitForAgentResponse(page, { timeout: 30_000 });

    // The process must still be alive immediately after replying — under
    // the old one-shot model it would already have exited by now.
    assert.equal(liveClaudeProcessCount(dir), 1, 'the process must still be running right after its first reply, not have exited');

    await sendMessage(page, 'What word did I just ask you to remember? Reply with just that word, lowercase.');
    const secondReply = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(secondReply.trim().toLowerCase(), 'papaya', 'the SAME process must genuinely remember the first turn');

    await waitForProcessCount(dir, 1);
  });

  test('Stop still ends the process, and the next message recovers normally', async () => {
    const dir = agentDir('claudia');
    const marker = join(dir, 'done.marker');
    await createChat(page, 'Stop Recovery Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });
    await waitForProcessCount(dir, 1);

    await sendMessage(
      page,
      '@Claudia use the Bash tool to run exactly: sleep 8 && touch done.marker. Do not reply until it finishes.'
    );
    await page.waitForFunction(
      () => document.querySelector('[data-testid="stream-stop-btn"]') !== null,
      { timeout: 15_000 }
    );
    await page.click(tid('stream-stop-btn'));
    await waitForAgentResponse(page, { timeout: 10_000 });

    const badge = await page.$(tid('msg-stopped-badge'));
    assert.ok(badge, 'the resulting message should show a "stopped" indicator');

    await new Promise((resolve) => setTimeout(resolve, 9000));
    assert.equal(existsSync(marker), false, 'the Bash command should have been killed, marker never created');

    // The interrupted process exits on its own (confirmed empirically) —
    // it should be gone shortly after the stop, not left running.
    await waitForProcessCount(dir, 0);

    // A normal follow-up must still work: fresh spawn, resumed via
    // --resume, no different from the agent's perspective.
    await sendMessage(page, 'Reply with exactly: recovered');
    const reply = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(reply, 'recovered');
    await waitForProcessCount(dir, 1);
  });

  test('removing an agent from its chat kills the process; deleting a chat kills its members\' processes', async () => {
    const dirA = agentDir('claudia');
    await createChat(page, 'Teardown Test A');
    await createAgent(page, { name: 'Claudia', workingDir: dirA, addToChat: true });
    await waitForProcessCount(dirA, 1);

    const agentItem = await page.$(tid('agent-item'));
    await agentItem.hover();
    await page.click(tid('agent-menu-btn'));
    await page.click(tid('agent-remove-btn'));
    await waitForProcessCount(dirA, 0);

    const dirB = agentDir('clauditor');
    await createChat(page, 'Teardown Test B');
    await createAgent(page, { name: 'Clauditor', workingDir: dirB, addToChat: true });
    await waitForProcessCount(dirB, 1);

    // Two chats are present in the sidebar at this point (A and B), so the
    // delete button must be scoped to chat B's own list item — a page-wide
    // tid('chat-del-btn') selector would hit chat A's instead (first in DOM
    // order).
    const chatItem = await page.$(tid('chat-item') + '.active');
    await chatItem.hover();
    await chatItem.$eval(tid('chat-del-btn'), (btn) => btn.click());
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-ok'));
    await waitForProcessCount(dirB, 0);
  });

  test('stopping the server leaves no orphaned claude processes behind', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Shutdown Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });
    await sendMessage(page, 'Reply with exactly: ok');
    await waitForAgentResponse(page, { timeout: 30_000 });
    await waitForProcessCount(dir, 1);

    // Exactly what a real deploy / tests/helpers/server.js's stopServer()
    // does: a plain kill of the Node process's own PID, nothing more —
    // proving the graceful-shutdown handler, not just that SOMETHING
    // eventually reaps it.
    await stopServer();
    await waitForProcessCount(dir, 0);
  });
});

describe('Persistent agent processes after a restart', () => {
  /** @type {import('puppeteer').Page} */
  let page;
  // A file database, unlike every other suite's :memory: one, so the chat
  // and its member are still there once the server comes back up.
  const dbDir = mkdtempSync(join(tmpdir(), 'agentwaggle-e2e-db-'));
  const dbEnv = { APP_DB_FILE: join(dbDir, 'data.sqlite3') };

  before(async () => {
    await startServer(dbEnv);
    await launchBrowser();
    page = await openPage();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
    cleanupAgentDirs();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('a restart spawns no processes until a chat is opened, then spawns only its members', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Restart Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });
    await waitForProcessCount(dir, 1);
    await closePage();

    await stopServer();
    await waitForProcessCount(dir, 0);
    await startServer(dbEnv);

    // A fresh page has no active chat, so nothing has asked for Claudia yet.
    page = await openPage();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(liveClaudeProcessCount(dir), 0, 'no agent process should start until its chat is opened');

    await page.click(tid('chat-item'));
    await waitForProcessCount(dir, 1);
  });
});
