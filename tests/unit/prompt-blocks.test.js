/**
 * @fileoverview Unit tests for buildPromptBlocks (server/ws/handler.js) — a
 * pure function, no `claude` subprocess involved.
 *
 * Confirmed empirically (raw spawn spike against the real CLI, not guessed)
 * that a resumed session keeps following instructions given in an earlier
 * invocation — including the [System] preamble's identity/roster/@mention
 * rules — without them being restated. Sending it on every turn was pure
 * duplication, same underlying issue as the conversation-history replay
 * fixed alongside catchUpMessagesFor. This only needs to go out once, on an
 * agent's first-ever turn IN THIS CHAT.
 *
 * That last part matters: the preamble is gated on whether this agent's own
 * messages actually appear in this chat's history (`priorMessages`), NOT on
 * `agent.resumeId`'s mere presence. Reported live: an agent created with a
 * manually-supplied resumeId pointing at a totally unrelated prior session
 * (routes/agents.js's optional resumeId field at creation) got skipped
 * straight past the preamble on its first-ever turn in the new chat, since
 * it "already had" a resumeId — leaving it cold-dropped into catch-up
 * context for a conversation and identity it was never actually introduced
 * to. Some tests below specifically cover that scenario.
 *
 * Separately: an agent that already spoke once never gets the full
 * [System] preamble (with its roster) resent — so if the chat's membership
 * changes after that, its own idea of "who's here" goes stale, with nothing
 * to correct it until a teammate's name happens to show up in catch-up
 * content by chance. Reported live, and much more likely for an Observer
 * specifically (long dormant stretches by design — see agent.isObserver):
 * a long-silent agent held onto a stale "(none — you are the only agent)"
 * roster while its own catch-up content plainly named teammates it was
 * never told about. Whenever there's catch-up content at all, a standalone
 * [Current chat roster] note now goes out alongside it — cheap (just the
 * roster, not the whole @mention-routing essay) but enough to keep it
 * honest. Covered below too.
 *
 * Separately: catch-up content isn't the only signal a stale roster needs —
 * membership changes (add/remove) don't create a chat message at all, so an
 * agent whose last turn happened to be the most recent thing in the chat
 * right before a teammate was removed gets zero catch-up and would
 * otherwise carry the stale roster forward indefinitely, sometimes even
 * @mentioning the departed teammate for a task no one will ever see.
 * chat.rosterChangedAt (db.js) is compared against this agent's own last
 * turn independently of catch-up content to cover that gap. Covered below.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptBlocks } from '../../server/ws/handler.js';

const chat = { id: 'chat1', name: 'Test Chat', memberAgentIds: ['claudia'], createdAt: new Date().toISOString() };
const members = [{ id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia' }];
const newMessage = { content: 'hello there', attachments: [] };

describe('buildPromptBlocks', () => {
  test('a first-ever turn (no resumeId) includes the [System] preamble', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia' };
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, []);
    const firstBlockText = blocks[0].text;
    assert.match(firstBlockText, /\[System\]/);
    assert.match(firstBlockText, /under the name "Claudia"/);
  });

  test('a resumed turn with nothing to catch up on skips the preamble entirely — just the new message, no leading empty block', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    // Claudia has genuinely already spoken in this chat before.
    const priorMessages = [{ id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] }];
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, priorMessages);
    assert.equal(blocks.length, 1, `expected only the final message block, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].text, 'hello there');
  });

  test('a resumed turn with genuine catch-up still omits the [System] preamble, but keeps the catch-up context', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] },
      { id: 'm1', agentId: 'clarence', authorName: 'Clarence', content: 'hi Claudia, please help', attachments: [] },
    ];
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, priorMessages);
    assert.equal(blocks.length, 2, `expected a catch-up block plus the new message block, got: ${JSON.stringify(blocks)}`);
    assert.doesNotMatch(blocks[0].text, /\[System\]/);
    assert.match(blocks[0].text, /Clarence/);
    assert.equal(blocks[1].text, 'hello there');
  });

  test('an agent resumed from a resumeId supplied manually at creation still gets the [System] preamble on its first turn in THIS chat', () => {
    // This is the actual reported bug: resumeId is set (pointing at some
    // unrelated prior session), but this agent has never actually spoken
    // in THIS chat — priorMessages contains no message authored by it.
    const agent = { id: 'claire', name: 'Claire', workingDir: '/tmp/claire', resumeId: 'unrelated-external-session' };
    const claireMembers = [...members, { id: 'claire', name: 'Claire', workingDir: '/tmp/claire' }];
    const priorMessages = [
      { id: 'm1', agentId: null, authorName: 'You', content: 'earlier, unrelated chat activity', attachments: [] },
    ];
    const blocks = buildPromptBlocks(agent, chat, claireMembers, newMessage, priorMessages);
    const firstBlockText = blocks[0].text;
    assert.match(firstBlockText, /\[System\]/, 'a manually-resumed agent must still be introduced the first time it speaks in this chat');
    assert.match(firstBlockText, /under the name "Claire"/);
    assert.match(firstBlockText, /alias/i, 'should explicitly frame the name as an alias, not assume it overrides prior context');
  });

  test('an agent that HAS already spoken in this chat correctly skips the preamble, even with a manually-supplied resumeId', () => {
    const agent = { id: 'claire', name: 'Claire', workingDir: '/tmp/claire', resumeId: 'unrelated-external-session' };
    const claireMembers = [...members, { id: 'claire', name: 'Claire', workingDir: '/tmp/claire' }];
    const priorMessages = [
      { id: 'm1', agentId: 'claire', authorName: 'Claire', content: 'already introduced myself here', attachments: [] },
    ];
    const blocks = buildPromptBlocks(agent, chat, claireMembers, newMessage, priorMessages);
    assert.equal(blocks.length, 1, `expected no preamble/catch-up, just the new message, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].text, 'hello there');
  });

  test('an agent whose only prior message is a CLI local-command interception still gets the [System] preamble', () => {
    // The reported bug: the agent's first-ever message in this chat happened
    // to be "@Name /chrome" — parseSkillInvocation used to strip that down
    // to a bare "/chrome" sent straight to the CLI, which recognized it as
    // one of ITS OWN built-in local commands (not this project's skills) and
    // answered locally, entirely client-side, before the model ever saw the
    // turn (or the [System] preamble sent alongside it). That reply still
    // got persisted as a normal agent message, so hasSpokenInChat looked
    // true from then on — permanently skipping the agent's real
    // introduction. isLocalCommandOnly marks exactly this case so it
    // doesn't count as the agent having genuinely spoken.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: "/chrome isn't available in this environment.", attachments: [], isLocalCommandOnly: true },
    ];
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, priorMessages);
    const firstBlockText = blocks[0].text;
    assert.match(firstBlockText, /\[System\]/, 'a local-command-only reply must not count as the agent having already spoken');
    assert.match(firstBlockText, /under the name "Claudia"/);
  });

  test('a long-dormant agent with new catch-up content gets a fresh roster note naming a teammate it was never introduced to', () => {
    // The exact reported scenario: Claudette spoke once (long ago, alone in
    // the chat), then Claire and Clark were added and had their own
    // exchange — Claudette's own [System] preamble (sent on that first,
    // long-ago turn) never mentioned them, since it doesn't get resent.
    const claudette = { id: 'claudette', name: 'Claudette', workingDir: '/tmp/claudette' };
    const claudetteChat = { id: 'chat2', name: 'wednesday', memberAgentIds: ['claudette', 'claire', 'clark'], createdAt: new Date().toISOString() };
    const claudetteMembers = [
      claudette,
      { id: 'claire', name: 'Claire', workingDir: '/tmp/claire' },
      { id: 'clark', name: 'Clark', workingDir: '/tmp/clark' },
    ];
    const priorMessages = [
      { id: 'm0', agentId: 'claudette', authorName: 'Claudette', content: 'my only prior turn, back when I was alone here', attachments: [] },
      { id: 'm1', agentId: 'claire', authorName: 'Claire', content: 'GW-161 investigation summary', attachments: [] },
      { id: 'm2', agentId: 'clark', authorName: 'Clark', content: 'GW-340 fix plan', attachments: [] },
    ];
    const blocks = buildPromptBlocks(claudette, claudetteChat, claudetteMembers, newMessage, priorMessages);
    assert.doesNotMatch(blocks[0].text, /\[System\]/, 'must not resend the full preamble — Claudette already spoke here once');
    assert.match(blocks[0].text, /\[Current chat roster\]/, 'must include a fresh, standalone roster note');
    assert.match(blocks[0].text, /Claire/);
    assert.match(blocks[0].text, /Clark/);
  });

  test('no roster note goes out when there is nothing to catch up on, even for a multi-agent chat', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const multiMembers = [...members, { id: 'clarence', name: 'Clarence', workingDir: '/tmp/clarence' }];
    const priorMessages = [{ id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] }];
    const blocks = buildPromptBlocks(agent, chat, multiMembers, newMessage, priorMessages);
    assert.equal(blocks.length, 1, `expected just the new message, no roster note, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].text, 'hello there');
  });

  test('a roster note goes out even with zero catch-up content, when a member was removed after this agent\'s last turn', () => {
    // The exact reported bug: Clarence gets removed from the chat with no
    // other chat activity in between, so there's nothing in `messages` to
    // reveal it (membership changes don't create a message). Without
    // rosterChangedAt, Claudia's next turn would carry the stale roster
    // forward and could still @mention Clarence, who is gone and will never
    // see it.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const staleChat = { ...chat, rosterChangedAt: '2026-08-13T12:00:00.000Z' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [], createdAt: '2026-08-13T11:00:00.000Z' },
    ];
    const blocks = buildPromptBlocks(agent, staleChat, members, newMessage, priorMessages);
    assert.equal(blocks.length, 2, `expected a roster-note block plus the new message block, got: ${JSON.stringify(blocks)}`);
    assert.doesNotMatch(blocks[0].text, /\[System\]/, 'must not resend the full preamble — Claudia already spoke here once');
    assert.match(blocks[0].text, /\[Current chat roster\]/);
  });

  test('no roster note when rosterChangedAt predates this agent\'s last turn — it already saw the current roster', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const freshChat = { ...chat, rosterChangedAt: '2026-08-13T10:00:00.000Z' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [], createdAt: '2026-08-13T11:00:00.000Z' },
    ];
    const blocks = buildPromptBlocks(agent, freshChat, members, newMessage, priorMessages);
    assert.equal(blocks.length, 1, `expected just the new message, no roster note, got: ${JSON.stringify(blocks)}`);
  });

  test('an agent already spoken-to gets the full [System] preamble again after a "/clear" since its last real turn', () => {
    // contextResetAt (stamped by store/db.js's recordContextClear once a
    // "/clear" turn rotates the CLI's session) must be treated the same way
    // a brand-new agent with no resumeId at all is — its live session
    // genuinely forgot everything, so skipping the preamble because
    // priorMessages contains an older reply would leave it with no idea who
    // it is or who its teammates are.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-2', contextResetAt: '2026-08-13T12:00:00.000Z' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply, before the clear', attachments: [], createdAt: '2026-08-13T11:00:00.000Z' },
      { id: 'm1', agentId: 'claudia', authorName: 'Claudia', content: '🧹 Context cleared — starting a fresh session', attachments: [], isSystemNote: true, createdAt: '2026-08-13T12:00:00.000Z' },
    ];
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, priorMessages);
    const firstBlockText = blocks[0].text;
    assert.match(firstBlockText, /\[System\]/, 'a cleared agent must be re-introduced, same as a never-yet-spoken one');
    assert.match(firstBlockText, /under the name "Claudia"/);
  });

  test('an agent that has already spoken AGAIN after the "/clear" correctly skips the preamble a second time', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-2', contextResetAt: '2026-08-13T12:00:00.000Z' };
    const priorMessages = [
      { id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: '🧹 Context cleared — starting a fresh session', attachments: [], isSystemNote: true, createdAt: '2026-08-13T12:00:00.000Z' },
      { id: 'm1', agentId: 'claudia', authorName: 'Claudia', content: 'hi again, freshly introduced', attachments: [], createdAt: '2026-08-13T12:05:00.000Z' },
    ];
    const blocks = buildPromptBlocks(agent, chat, members, newMessage, priorMessages);
    assert.equal(blocks.length, 1, `expected just the new message, no preamble, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].text, 'hello there');
  });

  test('the new message is labelled with its author, so a user question and a relayed teammate reply read differently', () => {
    // Reported live: an agent whose previous turn was a relay from a
    // teammate got the user's next question just as unlabelled, took it as
    // the teammate's, and answered the teammate instead of the user.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const priorMessages = [{ id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] }];
    const fromUser = buildPromptBlocks(agent, chat, members, { ...newMessage, from: { role: 'user', agentId: null, authorName: 'You' } }, priorMessages);
    const fromTeammate = buildPromptBlocks(agent, chat, members, { ...newMessage, from: { role: 'agent', agentId: 'clarence', authorName: 'Clarence' } }, priorMessages);
    assert.equal(fromUser.at(-1).text, 'You [user]: hello there');
    assert.equal(fromTeammate.at(-1).text, 'Clarence [agent clarence]: hello there');
  });

  test('two agents with the same name are told apart by id, and the user by role, in catch-up too', () => {
    // Names aren't unique: two agents can share one, and the user's display
    // name can be anything, a teammate's name included.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const priorMessages = [
      { id: 'm0', role: 'agent', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] },
      { id: 'm1', role: 'agent', agentId: 'sam-1', authorName: 'Sam', content: 'first Sam', attachments: [] },
      { id: 'm2', role: 'agent', agentId: 'sam-2', authorName: 'Sam', content: 'second Sam', attachments: [] },
      { id: 'm3', role: 'user', agentId: null, authorName: 'Sam', content: 'the user, also called Sam', attachments: [] },
    ];
    const catchUp = buildPromptBlocks(agent, chat, members, newMessage, priorMessages)[0].text;
    assert.match(catchUp, /^Sam \[agent sam-1\]: first Sam$/m);
    assert.match(catchUp, /^Sam \[agent sam-2\]: second Sam$/m);
    assert.match(catchUp, /^Sam \[user\]: the user, also called Sam$/m);
  });

  test('the roster gives every agent\'s id, the agent\'s own included', () => {
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia' };
    const multiMembers = [...members, { id: 'clarence', name: 'Clarence', workingDir: '/tmp/clarence' }];
    const preamble = buildPromptBlocks(agent, chat, multiMembers, newMessage, [])[0].text;
    assert.match(preamble, /Claudia \[agent claudia\] — this is you/);
    assert.match(preamble, /Clarence \[agent clarence\]/);
  });

  test('a message with no author (a skill command, a permission continuation) is sent exactly as given', () => {
    // A skill command has to reach the CLI starting with "/", or the CLI
    // won't recognize it as one.
    const agent = { id: 'claudia', name: 'Claudia', workingDir: '/tmp/claudia', resumeId: 'sess-1' };
    const priorMessages = [{ id: 'm0', agentId: 'claudia', authorName: 'Claudia', content: 'earlier reply', attachments: [] }];
    const blocks = buildPromptBlocks(agent, chat, members, { content: '/review src', attachments: [] }, priorMessages);
    assert.equal(blocks.at(-1).text, '/review src');
  });
});
