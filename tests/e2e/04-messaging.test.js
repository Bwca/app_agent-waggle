/**
 * @fileoverview E2E tests: sending messages, @mention autocomplete, and agent streaming.
 * Note: tests that trigger real Claude responses are slow (~10s each).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Messaging', () => {
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

  test('user message appears in the chat immediately', async () => {
    await createChat(page, 'Quick Chat');
    // No agents — message is saved but no response comes
    await sendMessage(page, 'Hello world');

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    const messages = await page.$$eval(
      tid('message') + '[data-role="user"] ' + tid('msg-content'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(messages.some((t) => t === 'Hello world'), `messages: ${messages}`);
  });

  test('@mention autocomplete shows matching agents', async () => {
    await createChat(page, 'Mention Test');
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '@Clau');

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="mention-dropdown"]')?.hidden,
      { timeout: 3000 }
    );

    const items = await page.$$eval(
      tid('mention-item'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(items.some((t) => t.includes('Claudia')), `mention items: ${items}`);
  });

  test('selecting a mention inserts @Name into the input', async () => {
    await createChat(page, 'Mention Insert');
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '@C');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="mention-item"]') !== null,
      { timeout: 3000 }
    );
    await page.click(tid('mention-item'));

    const value = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.ok(value.startsWith('@Claudia'), `input value: "${value}"`);
  });

  test('@mention autocomplete hides after Escape', async () => {
    await createChat(page, 'Escape Test');
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '@C');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="mention-dropdown"]')?.hidden,
      { timeout: 3000 }
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="mention-dropdown"]')?.hidden,
      { timeout: 3000 }
    );

    const hidden = await page.$eval(tid('mention-dropdown'), (el) => el.hidden);
    assert.ok(hidden, 'dropdown should be hidden after Escape');
  });

  test('agent responds with streaming bubble then final message', async () => {
    await createChat(page, 'Streaming Test');
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await sendMessage(page, '@Claudia reply with exactly: pong');

    const responseText = await waitForAgentResponse(page, { timeout: 90_000 });
    assert.ok(responseText.length > 0, 'agent response should be non-empty');

    // Streaming bubble should be gone
    const streamingGone = await page.$(tid('streaming-bubble'));
    assert.equal(streamingGone, null, 'streaming bubble should be removed after stream ends');
  });

  test('shows live tool activity and an elapsed-time counter while responding, not just a static label', async () => {
    await createChat(page, 'Live Status Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await sendMessage(page, "@Claudia use the Bash tool to run `sleep 2`, then reply with exactly: done");

    // While the Bash tool call is in flight, the status label should reflect
    // it (not the initial static "responding…" placeholder).
    await page.waitForFunction(
      () => /running/i.test(document.querySelector('[data-testid="msg-status-text"]')?.textContent ?? ''),
      { timeout: 30_000 }
    );
    // The elapsed-time counter should be ticking alongside it.
    await page.waitForFunction(
      () => /\(\d+s\)/.test(document.querySelector('[data-testid="msg-elapsed"]')?.textContent ?? ''),
      { timeout: 5000 }
    );

    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(responseText, 'done');
  });

  test('agent messages have copy-text and copy-as-image buttons that write to the clipboard', async () => {
    await createChat(page, 'Copy Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    // The real navigator.clipboard API can't be driven headlessly here (no OS
    // clipboard bridge available) — capture what the app actually passes to
    // it instead, the same technique already used for the fetch race test.
    await page.evaluate(() => {
      window.__copiedText = null;
      window.__copiedImageType = null;
      navigator.clipboard.writeText = async (text) => { window.__copiedText = text; };
      navigator.clipboard.write = async (items) => {
        const item = items[0];
        const type = item.types[0];
        const blob = await item.getType(type);
        window.__copiedImageType = blob.size > 100 ? type : null;
      };
    });

    await sendMessage(page, '@Claudia reply with exactly: pong');
    await waitForAgentResponse(page, { timeout: 90_000 });

    await page.hover(tid('message') + '[data-role="agent"]');
    await page.click(tid('msg-copy-text-btn'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-copy-text-btn"]')?.textContent === '✓',
      { timeout: 3000 }
    );
    const copiedText = await page.evaluate(() => window.__copiedText);
    assert.equal(copiedText, 'pong');

    await page.click(tid('msg-copy-image-btn'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-copy-image-btn"]')?.textContent === '✓',
      { timeout: 3000 }
    );
    const copiedImageType = await page.evaluate(() => window.__copiedImageType);
    assert.equal(copiedImageType, 'image/png', 'expected a non-trivial PNG to have been written to the clipboard');
  });

  test('@mention routes to the correct agent first', async () => {
    await createChat(page, 'Routing Test');
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });
    await createAgent(page, {
      name: 'Clauditor',
      workingDir: agentDir('clauditor'),
      addToChat: true,
    });

    await sendMessage(page, '@Claudia say: acknowledged');

    await waitForAgentResponse(page, { timeout: 90_000 });

    const firstAuthor = await page.$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (el) => el.textContent.trim()
    );
    assert.equal(firstAuthor, 'Claudia', 'first response must come from the @mentioned agent');

    // Claudia's reply ("acknowledged") contains no @mention, so she delegated
    // nothing — Clauditor must NOT be triggered as a false "relay".
    await new Promise((r) => setTimeout(r, 2000));
    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.deepEqual(authors, ['Claudia'], `only Claudia should have responded, got: ${authors}`);
  });

  test('an agent that explicitly @mentions a teammate correctly relays to them', async () => {
    await createChat(page, 'Relay Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    await sendMessage(page, '@Claudia reply with exactly this text, verbatim, nothing else: @Clauditor please handle this');
    await waitForAgentResponse(page, { timeout: 90_000 });

    // Clauditor should be triggered by Claudia's explicit @mention (relay).
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="msg-author"]')]
        .some((el) => el.textContent.trim() === 'Clauditor'),
      { timeout: 90_000 }
    );
    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.deepEqual(authors, ['Claudia', 'Clauditor'], `expected a real relay, got: ${authors}`);
  });

  test('an @mention in an earlier, unrelated turn does not trigger a stale relay', async () => {
    await createChat(page, 'Stale Relay Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    // Turn 1: broadcast (no mention) — both respond in the same turn, and
    // Claudia's reply @mentions Clauditor. Since Clauditor already responded
    // this same turn, relay correctly does nothing. Wait for BOTH replies
    // (not just one) to be rendered — each only renders client-side after
    // its server-side DB save completes — so turn 2 can't start until both
    // turn-1 messages are reliably the two most recent rows in the chat.
    // Note: the instruction below deliberately writes "@ Clauditor" (with a
    // space) rather than "@Clauditor" — the trigger message itself must not
    // contain a real mention, or this turn would route single-target instead
    // of broadcasting to both.
    await sendMessage(
      page,
      'Both of you: reply with exactly this text, verbatim, nothing else — except remove the single space between the @ symbol and the name: @ Clauditor ack'
    );
    await page.waitForFunction(
      () => new Set(
        [...document.querySelectorAll('[data-testid="message"][data-role="agent"] [data-testid="msg-author"]')]
          .map((el) => el.textContent.trim())
      ).size >= 2,
      { timeout: 90_000 }
    );

    // Turn 2: only Claudia is @mentioned, and her new reply contains no
    // mention at all. Clauditor must NOT respond again — even though
    // Claudia's turn-1 message (still among the chat's most recent rows)
    // mentioned Clauditor.
    await sendMessage(page, '@Claudia reply with exactly: done');
    await waitForAgentResponse(page, { timeout: 90_000 });

    await new Promise((r) => setTimeout(r, 2000));
    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    const clauditorCount = authors.filter((a) => a === 'Clauditor').length;
    assert.equal(
      clauditorCount, 1,
      `Clauditor should only have responded once (turn 1's broadcast), not relayed again from a stale mention; got: ${authors}`
    );
  });

  test('relay stays capped at one hop while the chat\'s free-relay toggle is off', async () => {
    await createChat(page, 'Bounded Relay Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    // Claudia's scripted reply hands Clauditor an instruction that itself
    // mentions Claudia back — with the toggle off, that back-mention must
    // NOT trigger a third turn.
    await sendMessage(
      page,
      '@Claudia reply with exactly this text, verbatim, nothing else: @Clauditor reply with exactly this text, verbatim, nothing else: @Claudia ack'
    );
    await waitForAgentResponse(page, { timeout: 90_000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="msg-author"]')]
        .some((el) => el.textContent.trim() === 'Clauditor'),
      { timeout: 90_000 }
    );
    // Give a would-be third hop a beat to (wrongly) start before asserting.
    await new Promise((r) => setTimeout(r, 3000));

    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.deepEqual(authors, ['Claudia', 'Clauditor'], `expected exactly one relay hop, got: ${authors}`);
  });

  test('free-relay toggle (🔁) lets a relay chain continue past one hop', async () => {
    await createChat(page, 'Free Relay Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    await page.click(tid('free-relay-btn'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="free-relay-btn"]')?.classList.contains('active'),
      { timeout: 3000 }
    );

    // Same scripted exchange as the bounded test above — Clauditor's reply
    // mentions Claudia back — but this time it should trigger Claudia again.
    await sendMessage(
      page,
      '@Claudia reply with exactly this text, verbatim, nothing else: @Clauditor reply with exactly this text, verbatim, nothing else: @Claudia ack'
    );
    await waitForAgentResponse(page, { timeout: 90_000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="msg-author"]')]
        .filter((el) => el.textContent.trim() === 'Claudia').length >= 2,
      { timeout: 90_000 }
    );

    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    // Not asserting an exact message sequence — once a relay hop's content
    // depends on a PREVIOUS relay hop's model output (rather than the
    // original scripted instruction), the model doesn't reliably forward
    // "reply verbatim" instructions word-for-word, so the exact chain length
    // and ordering past hop 2 isn't scriptable. What's actually under test
    // is the toggle's mechanism: with it off (previous test), Claudia is
    // provably capped at exactly one message; with it on, she must be
    // relayed again at least once.
    assert.deepEqual(authors.slice(0, 2), ['Claudia', 'Clauditor'], `expected the scripted first hop, got: ${authors}`);
    const claudiaCount = authors.filter((a) => a === 'Claudia').length;
    assert.ok(claudiaCount >= 2, `expected the relay to continue past one hop (Claudia relayed again), got: ${authors}`);
  });

  test('agent auto-chains its Claude session after the first turn', async () => {
    await createChat(page, 'Chaining Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await sendMessage(page, '@Claudia reply with exactly: pong');
    await waitForAgentResponse(page, { timeout: 90_000 });
    const agentsAfterFirst = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const afterFirst = agentsAfterFirst.find((a) => a.name === 'Claudia');
    assert.match(afterFirst.resumeId, /^[0-9a-f-]{36}$/, 'resumeId should be captured as a UUID after the first turn');

    // The agent panel should surface the session id once it's captured.
    await page.waitForSelector(tid('agent-session-btn'), { visible: true });
    const badgeText = await page.$eval(tid('agent-session-btn'), (el) => el.textContent);
    assert.ok(
      badgeText.includes(afterFirst.resumeId.slice(0, 8)),
      `session badge should show the resumeId's prefix, got: "${badgeText}"`
    );

    await sendMessage(page, '@Claudia reply with exactly: pong again');
    await waitForAgentResponse(page, { timeout: 90_000 });
    const agentsAfterSecond = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const afterSecond = agentsAfterSecond.find((a) => a.name === 'Claudia');
    assert.equal(afterSecond.resumeId, afterFirst.resumeId, 'resumeId must not change on subsequent turns');
  });

  test('"@Name /command" invokes a real Claude Code skill, not just chat text', async () => {
    const dir = agentDir('claudia');
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'commands', 'echo-test.md'), 'Reply with exactly: SLASH_COMMAND_FIRED\n');

    await createChat(page, 'Skill Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(page, '@Claudia /echo-test');
    const responseText = await waitForAgentResponse(page, { timeout: 90_000 });
    assert.equal(responseText, 'SLASH_COMMAND_FIRED', `expected the custom command's fixed output, got: "${responseText}"`);
  });

  test('messaging an agent whose working directory was deleted shows a clear error', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Deleted Dir Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // Delete the folder out from under the already-created agent — mirrors a
    // user removing the project directory after pointing an agent at it.
    rmSync(dir, { recursive: true, force: true });

    await sendMessage(page, '@Claudia hello');
    // No real Claude process is spawned for this case (the check happens
    // before spawn), so this resolves near-instantly — no need for a long timeout.
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="streaming-bubble"] [data-testid="msg-content"]')?.textContent ?? '').length > 0,
      { timeout: 10_000 }
    );
    const errorText = await page.$eval(
      '[data-testid="streaming-bubble"] [data-testid="msg-content"]',
      (el) => el.textContent
    );
    assert.match(errorText, /Claudia/);
    assert.match(errorText, /working directory no longer exists/i);
    assert.ok(errorText.includes(dir), `error should include the missing path, got: "${errorText}"`);
    // The turn is over, so there's nothing left to stop — a leftover Stop
    // button would sit on "Stopping…" forever.
    assert.equal(await page.$(tid('stream-stop-btn')), null, 'errored bubble should drop its Stop button');
  });

  test('spotlighting an agent hides your own messages addressed to someone else', async () => {
    await createChat(page, 'Filter Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    // Real agent turns fire in the background for these (broadcast reaches
    // both, a mention reaches its target) — irrelevant here, since the
    // filter only needs each user message to have rendered, not any reply.
    await sendMessage(page, 'hello everyone');
    await sendMessage(page, '@Claudia only for you');
    await sendMessage(page, '@Clauditor only for you');

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"][data-role="user"]').length === 3,
      { timeout: 5000 }
    );

    // Spotlight Claudia only.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const item = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Claudia');
      item.querySelector('.agent-filter-btn').click();
    });

    const visibleTexts = await page.$$eval(
      '[data-testid="message"][data-role="user"]:not([hidden]) [data-testid="msg-content"]',
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(visibleTexts.includes('hello everyone'), `broadcast should stay visible under filter, got: ${JSON.stringify(visibleTexts)}`);
    assert.ok(visibleTexts.includes('@Claudia only for you'), `message mentioning the spotlighted agent should stay visible, got: ${JSON.stringify(visibleTexts)}`);
    assert.ok(!visibleTexts.includes('@Clauditor only for you'), `message addressed to a different agent should be hidden, got: ${JSON.stringify(visibleTexts)}`);

    // Removing Clauditor from the chat, then reloading (forcing the message
    // list to rebuild from persisted history rather than the live DOM),
    // shouldn't turn their old "addressed to them" message into what looks
    // like a broadcast — it should stay hidden under Claudia's spotlight,
    // not resurface just because Clauditor is no longer a current member to
    // resolve the @mention against.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const item = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Clauditor');
      item.querySelector('.agent-remove-btn').click();
    });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('[data-testid="agent-name"]')].some((el) => el.textContent.trim() === 'Clauditor'),
      { timeout: 5000 }
    );

    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"][data-role="user"]').length === 3,
      { timeout: 5000 }
    );

    // Filter state doesn't survive a reload (selectChat clears it), so
    // re-spotlight Claudia before re-checking visibility.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const item = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Claudia');
      item.querySelector('.agent-filter-btn').click();
    });

    const visibleAfterReload = await page.$$eval(
      '[data-testid="message"][data-role="user"]:not([hidden]) [data-testid="msg-content"]',
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(
      !visibleAfterReload.includes('@Clauditor only for you'),
      `message addressed to a removed agent should stay hidden under a different agent's filter, got: ${JSON.stringify(visibleAfterReload)}`
    );
  });

  test('spotlighting an agent flags a reply from someone outside the focus as unseen', async () => {
    await createChat(page, 'Unseen Focus Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    // Spotlight Claudia before anyone's spoken — the indicator should only
    // ever reflect messages that arrive DURING focus mode, never retroactively.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const item = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Claudia');
      item.querySelector('.agent-filter-btn').click();
    });

    await sendMessage(page, 'Both of you: reply with exactly this text, verbatim, nothing else: ack');
    await page.waitForFunction(
      () => new Set(
        [...document.querySelectorAll('[data-testid="message"][data-role="agent"] [data-testid="msg-author"]')]
          .map((el) => el.textContent.trim())
      ).size >= 2,
      { timeout: 90_000 }
    );

    // Clauditor replied while spotlighted out — should show the
    // unseen-outside-focus dot; Claudia, being spotlighted, should not.
    await page.waitForFunction(
      () => {
        const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
        const clauditor = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Clauditor');
        return clauditor?.querySelector('[data-testid="agent-unseen-dot"]') != null;
      },
      { timeout: 5000 }
    );
    const claudiaHasDot = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const claudia = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Claudia');
      return claudia?.querySelector('[data-testid="agent-unseen-dot"]') != null;
    });
    assert.equal(claudiaHasDot, false, 'the spotlighted agent should never show the unseen-outside-focus indicator');

    // Spotlighting Clauditor too clears their indicator — their messages are
    // visible now, nothing left to flag as missed.
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const item = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Clauditor');
      item.querySelector('.agent-filter-btn').click();
    });
    const clauditorHasDotAfter = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="agent-item"]')];
      const clauditor = items.find((el) => el.querySelector('[data-testid="agent-name"]')?.textContent.trim() === 'Clauditor');
      return clauditor?.querySelector('[data-testid="agent-unseen-dot"]') != null;
    });
    assert.equal(clauditorHasDotAfter, false, 'spotlighting the agent should clear their unseen-outside-focus indicator');
  });

  test('the "@" button on an agent message inserts a mention into the composer', async () => {
    await createChat(page, 'Quick Mention Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    // Broadcast so both agents reply — gives each their own message (and
    // their own "@" button) to click.
    await sendMessage(page, 'Both of you: reply with exactly this text, verbatim, nothing else: ack');
    await page.waitForFunction(
      () => new Set(
        [...document.querySelectorAll('[data-testid="message"][data-role="agent"] [data-testid="msg-author"]')]
          .map((el) => el.textContent.trim())
      ).size >= 2,
      { timeout: 90_000 }
    );

    /** Clicks the "@" button on `authorName`'s message. */
    const clickMentionBtn = (authorName) => page.evaluate((authorName) => {
      const msg = [...document.querySelectorAll('[data-testid="message"][data-role="agent"]')]
        .find((el) => el.querySelector('[data-testid="msg-author"]')?.textContent.trim() === authorName);
      msg.querySelector('[data-testid="msg-mention-btn"]').click();
    }, authorName);

    // Something already typed, no trailing space — the button should add
    // one before the mention rather than running the two together.
    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), 'hey');

    await clickMentionBtn('Claudia');
    const value = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.equal(value, 'hey @Claudia ', `expected the mention inserted with a separating space, got: ${JSON.stringify(value)}`);

    // Clicking a second agent's button appends theirs too, addressing both.
    await clickMentionBtn('Clauditor');
    const valueAfterSecond = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.equal(
      valueAfterSecond, 'hey @Claudia @Clauditor ',
      `expected both agents mentioned, got: ${JSON.stringify(valueAfterSecond)}`
    );
  });
});
