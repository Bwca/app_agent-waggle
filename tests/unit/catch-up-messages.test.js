/**
 * @fileoverview Unit tests for catchUpMessagesFor (server/ws/handler.js) — a
 * pure function, no `claude` subprocess involved, so a plain node:test unit
 * test is the right tool here rather than a full e2e/Puppeteer run.
 *
 * Context: each agent is a real, resumed `claude` CLI session. Once it has a
 * resumeId, Claude already natively remembers every turn where IT was the
 * one invoked — re-sending that same history as a "[Conversation context]"
 * block on every single turn was pure duplication (and, separately, the
 * triggering message itself was being sent twice: once in that replay,
 * once as the turn's own final content block). This function is what fixes
 * both: it narrows a raw message window down to only what a given agent
 * doesn't already have.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { catchUpMessagesFor } from '../../server/ws/handler.js';

function msg(id, agentId, content, extra = {}) {
  return { id, chatId: 'chat1', role: agentId ? 'agent' : 'user', agentId, authorName: agentId ?? 'User', content, attachments: [], createdAt: new Date().toISOString(), ...extra };
}

describe('catchUpMessagesFor', () => {
  test('an agent with no resumeId yet gets the full window (no session memory at all)', () => {
    const agent = { id: 'claudia', name: 'Claudia' };
    const messages = [msg('1', null, 'hi'), msg('2', 'claudia', 'hello'), msg('3', null, 'how are you')];
    assert.deepEqual(catchUpMessagesFor(agent, messages), messages);
  });

  test('a resumed agent in a 1:1 chat gets nothing — every message is already in its own session', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const messages = [
      msg('1', null, 'first question'),
      msg('2', 'claudia', 'first answer'),
      msg('3', null, 'second question'),
      msg('4', 'claudia', 'second answer'),
    ];
    // Everything here is either the user talking directly to Claudia or
    // Claudia's own replies — all of it is already in her resumed session.
    assert.deepEqual(catchUpMessagesFor(agent, messages), []);
  });

  test('a resumed agent only gets messages strictly after its own last turn', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const messages = [
      msg('1', null, 'hi everyone'),
      msg('2', 'claudia', 'hi from claudia'),
      msg('3', 'clarence', 'hi from clarence'),
      msg('4', null, 'ok thanks both'),
    ];
    const result = catchUpMessagesFor(agent, messages);
    assert.deepEqual(result.map((m) => m.id), ['3', '4']);
  });

  test('a resumed agent never gets its own past messages back, even mixed in among catch-up ones', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const messages = [
      msg('1', 'claudia', 'my last reply'),
      msg('2', 'clarence', 'clarence says hi'),
      msg('3', 'claudia', 'wait, this should never appear — it is not actually possible chronologically, but the filter must still exclude it defensively'),
    ];
    const result = catchUpMessagesFor(agent, messages);
    assert.ok(!result.some((m) => m.agentId === 'claudia'), 'no message authored by the agent itself should ever be in its own catch-up');
  });

  test('an agent that has never spoken in this window (but has a resumeId from elsewhere) gets the whole window minus its own messages', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const messages = [msg('1', 'clarence', 'a'), msg('2', null, 'b'), msg('3', 'clarence', 'c')];
    assert.deepEqual(catchUpMessagesFor(agent, messages).map((m) => m.id), ['1', '2', '3']);
  });

  test('a local-command-only reply is skipped as the "last own turn" boundary — nothing sent alongside it actually reached the model', () => {
    // Even though the agent's session DID capture a resumeId from this turn
    // (it's the same live process, session genuinely exists), the CLI's own
    // local-command dispatcher intercepted the turn before the model saw
    // anything — including whatever catch-up context would have gone out
    // alongside it. Treating it as a real "last turn" boundary would wrongly
    // assume the model already knows everything before it.
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const messages = [
      msg('1', 'clarence', 'clarence says hi'),
      msg('2', 'claudia', "/chrome isn't available in this environment.", { isLocalCommandOnly: true }),
      msg('3', null, 'ok thanks'),
    ];
    const result = catchUpMessagesFor(agent, messages);
    assert.deepEqual(result.map((m) => m.id), ['1', '3'], 'must catch up on everything except its own messages, not just what follows the local-command reply');
  });

  test('a "/clear" since the agent\'s last own turn wipes its session memory — the full window goes out, not just what followed that turn', () => {
    // The agent DID speak after message '1', but a /clear happened after
    // that reply — its live CLI session no longer has any memory of it, so
    // that old turn can't be trusted as a "last own turn" boundary anymore.
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-2', contextResetAt: '2026-01-01T00:00:10.000Z' };
    const messages = [
      msg('1', 'clarence', 'clarence says hi', { createdAt: '2026-01-01T00:00:00.000Z' }),
      msg('2', 'claudia', 'hi clarence', { createdAt: '2026-01-01T00:00:05.000Z' }),
      msg('3', 'claudia', '🧹 Context cleared — starting a fresh session', { createdAt: '2026-01-01T00:00:10.000Z', isSystemNote: true }),
      msg('4', null, 'claudia, are you there?', { createdAt: '2026-01-01T00:00:15.000Z' }),
    ];
    const result = catchUpMessagesFor(agent, messages);
    assert.deepEqual(result.map((m) => m.id), ['1', '4'], 'the pre-clear own turn must not count as a memory boundary, so everything but the agent\'s own messages goes out');
  });

  test('an own turn AFTER the "/clear" is still a valid memory boundary', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-3', contextResetAt: '2026-01-01T00:00:10.000Z' };
    const messages = [
      msg('1', 'clarence', 'before the clear', { createdAt: '2026-01-01T00:00:00.000Z' }),
      msg('2', 'claudia', '🧹 Context cleared — starting a fresh session', { createdAt: '2026-01-01T00:00:10.000Z', isSystemNote: true }),
      msg('3', null, 'hi again claudia', { createdAt: '2026-01-01T00:00:15.000Z' }),
      msg('4', 'claudia', 'hi!', { createdAt: '2026-01-01T00:00:20.000Z' }),
      msg('5', 'clarence', 'one more thing', { createdAt: '2026-01-01T00:00:25.000Z' }),
    ];
    const result = catchUpMessagesFor(agent, messages);
    assert.deepEqual(result.map((m) => m.id), ['5'], 'the post-clear reply is a genuine memory boundary, so only what came after it is new');
  });

  test('a teammate joining or leaving goes out as catch-up, unlike other system notes', () => {
    const agent = { id: 'claudia', name: 'Claudia', resumeId: 'sess-1' };
    const roster = { authorName: 'System', isSystemNote: true };
    const messages = [
      msg('1', 'claudia', 'my last reply'),
      msg('2', 'oona', '➕ You added Oona [agent oona] to the chat', roster),
      msg('3', null, '@Oona you\'re alive?'),
      msg('4', 'oona', '🚪 You removed Oona [agent oona] from the chat', roster),
      msg('5', 'clarence', '🗜️ Clarence\'s context was compacted (auto): size unreported', { isSystemNote: true }),
    ];
    assert.deepEqual(catchUpMessagesFor(agent, messages).map((m) => m.id), ['2', '3', '4']);
  });
});

describe('catchUpMessagesFor — seenUntil', () => {
  const at = (iso) => ({ createdAt: iso });

  test('a message posted while the agent\'s turn was running still reaches it, though it predates the agent\'s reply', () => {
    const agent = { id: 'claus', name: 'Claus', resumeId: 'sess-1', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [
      msg('1', null, 'seen before the turn', at('2026-10-16T01:00:00.000Z')),
      msg('2', 'clay', 'posted mid-turn', at('2026-10-16T01:05:00.000Z')),
      msg('3', 'claus', 'the long turn\'s reply', at('2026-10-16T01:08:00.000Z')),
      msg('4', null, 'posted after', at('2026-10-16T01:09:00.000Z')),
    ];
    const caughtUp = catchUpMessagesFor(agent, messages).map((m) => m.id);
    assert.deepEqual(caughtUp, ['2', '4']);
  });

  test('nothing already seen is re-sent', () => {
    const agent = { id: 'claus', name: 'Claus', resumeId: 'sess-1', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [msg('1', null, 'old', at('2026-10-16T01:00:00.000Z')), msg('2', 'clay', 'also old', at('2026-10-16T01:00:30.000Z'))];
    assert.deepEqual(catchUpMessagesFor(agent, messages), []);
  });

  test('a message saved in the same millisecond as the prompt build is re-sent rather than risked', () => {
    const agent = { id: 'claus', name: 'Claus', resumeId: 'sess-1', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [msg('1', null, 'same instant', at('2026-10-16T01:01:00.000Z'))];
    assert.deepEqual(catchUpMessagesFor(agent, messages).map((m) => m.id), ['1']);
  });

  test('a "/clear" after seenUntil voids it — back to the reply boundary rules', () => {
    const agent = { id: 'claus', name: 'Claus', resumeId: 'sess-2', contextResetAt: '2026-10-16T01:02:00.000Z', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [msg('1', null, 'before the clear', at('2026-10-16T01:00:00.000Z')), msg('2', null, 'after', at('2026-10-16T01:03:00.000Z'))];
    assert.deepEqual(catchUpMessagesFor(agent, messages).map((m) => m.id), ['1', '2']);
  });

  test('a roster note about the agent itself still goes out — it was re-added, say', () => {
    const agent = { id: 'claus', name: 'Claus', resumeId: 'sess-1', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [msg('1', 'claus', '➕ You added Claus [agent claus] to the chat', { ...at('2026-10-16T01:02:00.000Z'), authorName: 'System', isSystemNote: true })];
    assert.deepEqual(catchUpMessagesFor(agent, messages).map((m) => m.id), ['1']);
  });

  test('ignored for an agent with no session yet — the full window still goes out', () => {
    const agent = { id: 'claus', name: 'Claus', seenUntil: '2026-10-16T01:01:00.000Z' };
    const messages = [msg('1', null, 'old', at('2026-10-16T01:00:00.000Z'))];
    assert.deepEqual(catchUpMessagesFor(agent, messages), messages);
  });
});
