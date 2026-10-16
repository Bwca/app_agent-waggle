/**
 * @fileoverview E2E tests: the permission-denial card and its "Grant" flow.
 * Bash-tool denials (acceptEdits never auto-approves Bash) need a distinct
 * grant mechanism from file-path-scoped denials (Write/Edit/Read/NotebookEdit,
 * which acceptEdits DOES auto-approve within --add-dir scope, but only if the
 * path was already known — a path outside workingDir still needs a grant).
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Permission grants', () => {
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

  /**
   * Waits for a permission card to appear after an agent's response finishes,
   * and returns every denied row's tool name + displayed value — a turn can
   * produce more than one denial (e.g. the model tries a Bash workaround
   * before/alongside the tool it was actually asked to use).
   * @returns {Promise<{ toolName: string, value: string }[]>}
   */
  async function waitForPermCard() {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="perm-card"]') !== null,
      { timeout: 15_000 }
    );
    // .perm-tool/.perm-path are plain CSS classes on the card's rows, not
    // data-testids (only the card itself and the grant button have those).
    return page.$$eval('.perm-row', (rows) => rows.map((row) => ({
      toolName: row.querySelector('.perm-tool').textContent,
      value: row.querySelector('.perm-path').textContent,
    })));
  }

  /**
   * Denies every row EXCEPT `excludeIdx` in the current card. The server
   * only auto-continues once every row in a card is resolved — not just
   * whichever one a test cares about — so any incidental extra denial (the
   * model exploring via a Bash `ls` before the real action, say) has to be
   * resolved too, or the agent's turn is never nudged to continue and a
   * subsequent waitForAgentResponse hangs. This mirrors what a real user
   * now has to do with a multi-row card, not a test-only workaround.
   * @param {import('puppeteer').ElementHandle[]} rowHandles
   * @param {number} excludeIdx
   * @returns {Promise<void>}
   */
  async function resolveOtherRows(rowHandles, excludeIdx) {
    for (let i = 0; i < rowHandles.length; i++) {
      if (i === excludeIdx) continue;
      await rowHandles[i].$eval('.perm-deny-btn', (btn) => btn.click());
      await page.waitForFunction(
        (j) => document.querySelectorAll('.perm-row')[j]?.querySelector('.perm-deny-btn')?.textContent.includes('✕'),
        { timeout: 3000 },
        i
      );
    }
  }

  /**
   * Finds the denial row for a specific tool (a turn can produce more than
   * one denial — e.g. the model tries a Bash workaround alongside the tool
   * it was actually asked to use) and clicks THAT row's own grant button,
   * then resolves every other row in the card (see resolveOtherRows).
   * @param {string} expectedToolName
   * @returns {Promise<string>} that row's displayed value
   */
  async function grantRowForTool(expectedToolName) {
    const rows = await waitForPermCard();
    const idx = rows.findIndex((r) => r.toolName === expectedToolName);
    assert.ok(idx !== -1, `expected a "${expectedToolName}" denial, got: ${JSON.stringify(rows)}`);

    const rowHandles = await page.$$('.perm-row');
    await rowHandles[idx].$eval('.perm-grant-btn', (btn) => btn.click());
    await page.waitForFunction(
      (i) => document.querySelectorAll('.perm-row')[i]?.querySelector('.perm-grant-btn')?.textContent.includes('✓'),
      { timeout: 3000 },
      idx
    );

    await resolveOtherRows(rowHandles, idx);

    return rows[idx].value;
  }

  test('a denied Bash command renders a card with the tool name and literal command', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Bash Denial Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git init -q && git add -A');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    const bashRow = rows.find((r) => r.toolName === 'Bash');
    assert.ok(bashRow, `expected a Bash denial, got: ${JSON.stringify(rows)}`);
    assert.match(bashRow.value, /git init -q && git add -A/);
  });

  test('a turn with the same command denied twice only shows one row to grant, not two', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Duplicate Denial Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // acceptEdits denies every Bash call outright, so asking the model to
    // retry the exact same command once before replying reliably produces
    // two denial entries for the identical tool+command within one turn —
    // this is what actually happened in the reported bug: the permission
    // card rendered one row per raw denial with no dedup, so granting the
    // first row left an identical second row still demanding its own grant.
    await sendMessage(
      page,
      '@Claudia use the Bash tool to run exactly: git push origin master. ' +
      'If it is denied, immediately retry the exact same Bash command once more before replying.'
    );
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    const pushRows = rows.filter((r) => r.toolName === 'Bash' && r.value.includes('git push'));
    assert.equal(
      pushRows.length, 1,
      `expected the repeated identical denial to be deduped to one row, got: ${JSON.stringify(rows)}`
    );
  });

  test('a chained command denied, then retried standalone, only shows one row — not two "different" denials for the same grant', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Subset Denial Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // Reported live: granting "node --version && npm --version" already
    // covers "npm --version" alone (deriveToolPatterns splits the chain
    // into one pattern per sub-command), so a retry with just the
    // sub-command is a redundant ask, not a genuinely separate one — even
    // though the two denials' literal command text differs, so the older
    // exact-match dedupe alone doesn't catch this.
    await sendMessage(
      page,
      '@Claudia use the Bash tool to run exactly: node --version && npm --version. ' +
      'If it is denied, immediately retry using just: npm --version'
    );
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    const bashRows = rows.filter((r) => r.toolName === 'Bash');
    assert.equal(
      bashRows.length, 1,
      `expected the standalone retry to be dropped as already-covered, got: ${JSON.stringify(rows)}`
    );
    assert.match(bashRows[0].value, /node --version && npm --version/);
  });

  test('granting a Bash denial auto-continues the turn and actually authorizes it', async () => {
    const dir = agentDir('claudia');
    execSync('git init -q', { cwd: dir });
    writeFileSync(join(dir, 'task.md'), 'x');

    await createChat(page, 'Bash Grant Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // This exact shape (git add chained with git status via &&) is what the
    // originally-reported bug hit: acceptEdits denies it outright as
    // "multiple operations".
    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git add task.md && git status');
    await waitForAgentResponse(page, { timeout: 30_000 });
    await grantRowForTool('Bash');

    // No follow-up message typed — granting must, on its own, re-prompt the
    // agent to retry the exact action that was just denied.
    await waitForAgentResponse(page, { timeout: 30_000 });

    // No new permission card for this turn.
    const cards = await page.$$(tid('perm-card'));
    assert.equal(cards.length, 1, 'no additional perm-card should appear once the pattern is granted');

    // Real, independently-observable side effect: the auto-continued retry
    // actually ran git add.
    const status = execSync('git status --short', { cwd: dir }).toString();
    assert.equal(status.trim(), 'A  task.md', 'task.md should now be staged via the auto-continued retry');
  });

  test('granting a file-path denial (Write outside workingDir) auto-continues and still works as before', async () => {
    const workDir = agentDir('claudia');
    const outsideDir = agentDir('outside');
    const targetFile = join(outsideDir, 'notes.txt');

    await createChat(page, 'File Grant Test');
    await createAgent(page, { name: 'Claudia', workingDir: workDir, addToChat: true });

    await sendMessage(page, `@Claudia use the Write tool to create the file ${targetFile} with content: hello`);
    await waitForAgentResponse(page, { timeout: 30_000 });

    assert.equal(existsSync(targetFile), false, 'the file must not exist yet — the write was denied');
    const grantedValue = await grantRowForTool('Write');
    assert.equal(grantedValue, targetFile);

    // No follow-up message typed — granting must, on its own, re-prompt the
    // agent to retry the write it was just denied.
    await waitForAgentResponse(page, { timeout: 30_000 });

    assert.equal(existsSync(targetFile), true, 'the file should now exist — the grant authorized the write');
    assert.equal(readFileSync(targetFile, 'utf-8').trim(), 'hello');
  });

  test('denying a Bash denial does not authorize it, but still nudges the agent to continue', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Deny Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    // Same shape as the "renders a card" test above — a chained command
    // acceptEdits reliably denies outright as "multiple operations".
    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git init -q && git add -A');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    const idx = rows.findIndex((r) => r.toolName === 'Bash');
    assert.ok(idx !== -1, `expected a Bash denial, got: ${JSON.stringify(rows)}`);

    const rowHandles = await page.$$('.perm-row');
    await rowHandles[idx].$eval('.perm-deny-btn', (btn) => btn.click());

    // Clicking Deny must resolve the row for good — both buttons disabled,
    // not just the one clicked, so there's no way to grant-after-deny (or
    // vice versa) the same denial.
    const [denyState, grantState] = await Promise.all([
      rowHandles[idx].$eval('.perm-deny-btn', (btn) => ({ text: btn.textContent, disabled: btn.disabled })),
      rowHandles[idx].$eval('.perm-grant-btn', (btn) => btn.disabled),
    ]);
    assert.ok(denyState.text.includes('✕'), `deny button text: "${denyState.text}"`);
    assert.ok(denyState.disabled, 'deny button should be disabled after being clicked');
    assert.ok(grantState, 'grant button should also be disabled once the row is denied');

    await resolveOtherRows(rowHandles, idx);

    // No follow-up message typed — denying must, on its own, re-prompt the
    // agent to continue, same as granting does.
    await waitForAgentResponse(page, { timeout: 30_000 });

    // Real, independently-observable side effect: the denied command never ran.
    assert.equal(existsSync(join(dir, '.git')), false, 'denying must not have authorized the command');

    // Precise, model-behavior-independent proof that nothing was persisted:
    // check the agent's own stored state directly, rather than asking it to
    // retry in natural language — the deny nudge tells it the action was
    // declined, and a real model can reasonably choose not to attempt the
    // exact same thing again even when re-asked, which would make a
    // retry-based check flaky through no fault of the underlying fix.
    const agents = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const agent = agents.find((a) => a.name === 'Claudia');
    assert.ok(
      !agent.allowedToolPatterns?.length,
      `denying must not add any allowedToolPatterns, got: ${JSON.stringify(agent.allowedToolPatterns)}`
    );
  });

  test('YOLO mode bypasses permission checks entirely, right from the first turn', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'YOLO Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true, yoloMode: true });

    // Badge shown in the agent panel.
    const badge = await page.$(tid('agent-yolo-badge'));
    assert.ok(badge, 'the agent panel should show the YOLO badge');

    // A compound command that a normal agent would get denied on outright
    // (see the earlier "multiple operations" tests) should just work, with
    // no permission card at all, on the very first turn.
    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git init -q && git status, then reply with exactly: done');
    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(responseText, 'done');

    const cards = await page.$$(tid('perm-card'));
    assert.equal(cards.length, 0, 'no permission card should ever appear for a YOLO-mode agent');

    // Real, independently-observable side effect: git init actually ran.
    assert.equal(existsSync(join(dir, '.git')), true, 'git init should have actually run, unprompted');
  });

  test('a multi-row permission card only nudges the agent to continue once every row is resolved', async () => {
    const workDir = agentDir('claudia');
    const outsideDir = agentDir('outside');
    const targetFile = join(outsideDir, 'notes.txt');

    await createChat(page, 'Multi Row Test');
    await createAgent(page, { name: 'Claudia', workingDir: workDir, addToChat: true });

    await sendMessage(
      page,
      `@Claudia in this single turn, attempt BOTH of the following even if one is denied: ` +
      `(1) use the Bash tool to run exactly: git init -q && git add -A, and ` +
      `(2) use the Write tool to create the file ${targetFile} with content: hello. ` +
      `Then reply with exactly: done`
    );
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    const bashIdx = rows.findIndex((r) => r.toolName === 'Bash');
    const writeIdx = rows.findIndex((r) => r.toolName === 'Write');
    assert.ok(bashIdx !== -1, `expected a Bash denial, got: ${JSON.stringify(rows)}`);
    assert.ok(writeIdx !== -1, `expected a Write denial, got: ${JSON.stringify(rows)}`);

    const rowHandles = await page.$$('.perm-row');

    // Resolve every row EXCEPT Write first — grant Bash, deny anything else
    // incidental. The card still isn't fully resolved, so the agent must
    // NOT be nudged to continue yet, no matter what was already granted.
    await rowHandles[bashIdx].$eval('.perm-grant-btn', (btn) => btn.click());
    await page.waitForFunction(
      (i) => document.querySelectorAll('.perm-row')[i]?.querySelector('.perm-grant-btn')?.textContent.includes('✓'),
      { timeout: 3000 }, bashIdx
    );
    for (let i = 0; i < rowHandles.length; i++) {
      if (i === bashIdx || i === writeIdx) continue;
      await rowHandles[i].$eval('.perm-deny-btn', (btn) => btn.click());
    }

    // Give an (incorrect, if this ever regresses) early auto-continue a
    // real chance to fire before asserting it didn't — a fixed wait, not a
    // race against a negative assertion that could just pass by being too
    // fast to observe it.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.equal(
      await page.$(tid('streaming-bubble')), null,
      'the agent must not start responding again before the LAST row in the card is resolved'
    );
    assert.equal(
      existsSync(join(workDir, '.git')), false,
      'the already-GRANTED Bash action must not have run yet either — nothing continues until the whole card is resolved'
    );

    // Now resolve the final row — THIS should trigger the auto-continue.
    // Starts with, not equals — see the "Grant all" test below.
    await rowHandles[writeIdx].$eval('.perm-grant-btn', (btn) => btn.click());
    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.match(responseText, /^done\b/, `expected the reply to start with "done", got: ${JSON.stringify(responseText)}`);

    // Real, independently-observable side effects: BOTH actions ran, once
    // the card was fully resolved — proving the earlier grant (Bash) really
    // did take effect, not just whichever row was resolved last.
    assert.equal(existsSync(join(workDir, '.git')), true, 'the Bash action (granted earlier) should now have run');
    assert.equal(existsSync(targetFile), true, 'the Write action (granted last) should have run');
  });

  test('"Grant all" grants every row in a multi-row card at once and auto-continues the turn', async () => {
    const workDir = agentDir('claudia');
    const outsideDir = agentDir('outside');
    const targetFile = join(outsideDir, 'notes.txt');

    await createChat(page, 'Grant All Test');
    await createAgent(page, { name: 'Claudia', workingDir: workDir, addToChat: true });

    await sendMessage(
      page,
      `@Claudia in this single turn, attempt BOTH of the following even if one is denied: ` +
      `(1) use the Bash tool to run exactly: git init -q && git add -A, and ` +
      `(2) use the Write tool to create the file ${targetFile} with content: hello. ` +
      `Then reply with exactly: done`
    );
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    assert.equal(rows.length, 2, `expected exactly two denial rows, got: ${JSON.stringify(rows)}`);

    const grantAllBtn = await page.$(tid('perm-grant-all-btn'));
    assert.ok(grantAllBtn, 'expected a "Grant all" button on a multi-row card');
    await grantAllBtn.click();

    await page.waitForFunction(
      () => [...document.querySelectorAll('.perm-grant-btn')].every((btn) => btn.textContent.includes('✓')),
      { timeout: 3000 }
    );

    // No follow-up message typed — the bulk grant must, on its own, nudge
    // the agent to retry both actions it was just denied.
    // Starts with, not equals: having said "done" the first time while
    // both actions were actually blocked, the model sometimes adds a line
    // correcting that. The side effects below are the real check.
    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.match(responseText, /^done\b/, `expected the reply to start with "done", got: ${JSON.stringify(responseText)}`);

    // Real, independently-observable side effects: BOTH actions ran off a
    // single click, proving the bulk grant actually authorized every row,
    // not just triggered the auto-continue on its own.
    assert.equal(existsSync(join(workDir, '.git')), true, 'the Bash action should have run via the bulk grant');
    assert.equal(existsSync(targetFile), true, 'the Write action should have run via the bulk grant');
  });

  test('"Grant all" is not shown on a single-row card — nothing to bulk-resolve', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Single Row No Bulk Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git init -q && git add -A');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const rows = await waitForPermCard();
    assert.equal(rows.length, 1, `expected exactly one denial row, got: ${JSON.stringify(rows)}`);

    const grantAllBtn = await page.$(tid('perm-grant-all-btn'));
    assert.equal(grantAllBtn, null, 'a single-row card should not show a bulk grant button');
  });
});
