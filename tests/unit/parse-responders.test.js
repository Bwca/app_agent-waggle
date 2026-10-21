/**
 * @fileoverview Unit tests for parseResponders/extractMentionedAgents
 * (server/services/messageRouter.js) — pure functions, no `claude`
 * subprocess involved.
 *
 * Context: an "observer" agent (agent.isObserver) exists to silently watch
 * a busy chat and summarize it on demand — it must never be pulled into
 * responding to a plain broadcast message (no @mention), only to an
 * explicit @mention (typed directly, relayed by a teammate's reply, or via
 * a scheduled message, all of which resolve through these same functions).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResponders, extractMentionedAgents, parseSkillInvocation } from '../../server/services/messageRouter.js';

function agent(id, name, isObserver = false) {
  return isObserver ? { id, name, isObserver: true } : { id, name };
}

describe('parseResponders', () => {
  test('a broadcast (no mention) reaches everyone when there are no observers — unchanged behavior', () => {
    const a = agent('a', 'Alice');
    const b = agent('b', 'Bob');
    assert.deepEqual(parseResponders('hello team', [a, b]), [a, b]);
  });

  test('a broadcast excludes an observer but still reaches non-observer members', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('hello team', [a, observer]), [a]);
  });

  test('a broadcast in an all-observer chat resolves to an empty list without throwing', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('hello team', [observer]), []);
  });

  test('an explicit @mention of an observer still routes to it', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('@Overseer please summarize', [a, observer]), [observer]);
  });

  test('an explicit @mention of a non-observer is unaffected by an observer merely being present in the chat', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('@Alice go', [a, observer]), [a]);
  });

  test('a multi-mention message including an observer resolves both — mentions always bypass the broadcast filter', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    const result = parseResponders('@Alice @Overseer sync up', [a, observer]);
    assert.deepEqual(new Set(result), new Set([a, observer]));
  });
});

describe('extractMentionedAgents', () => {
  test('still matches an observer by name, regardless of broadcast rules — needed for the relay path', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(extractMentionedAgents('cc @Overseer for visibility', [observer]), [observer]);
  });

  test('returns empty (not "everyone") when nothing is mentioned — never falls back to broadcast', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(extractMentionedAgents('no mentions here', [observer]), []);
  });

  test('matches a hyphenated agent name in full, not just up to the hyphen', () => {
    // Regression: a fixed \w+ character class doesn't include "-", so
    // "@TP-Observer" used to capture only "TP", match no agent, and
    // silently fall through parseResponders to a broadcast instead of
    // routing to the intended agent.
    const observer = agent('c', 'TP-Observer', true);
    assert.deepEqual(extractMentionedAgents('@TP-Observer reply please', [observer]), [observer]);
  });

  test('a longer hyphenated name is not shadowed by a shorter agent name that is its prefix', () => {
    const short = agent('a', 'TP');
    const long = agent('b', 'TP-Observer');
    assert.deepEqual(extractMentionedAgents('@TP-Observer only', [short, long]), [long]);
  });

  test('a short name is not falsely matched inside a longer unrelated word', () => {
    const bob = agent('a', 'Bob');
    assert.deepEqual(extractMentionedAgents('@Bobby, not you', [bob]), []);
  });
});

describe('parseResponders — hyphenated names', () => {
  test('an @mention of a hyphenated-name agent routes to it alone, not a broadcast fallback', () => {
    const alice = agent('a', 'TP-Alice');
    const bob = agent('b', 'TP-Bob');
    assert.deepEqual(parseResponders('@TP-Alice only you should reply', [alice, bob]), [alice]);
  });
});

describe('parseSkillInvocation — hyphenated names', () => {
  // parseSkillInvocation checks a real registered command via a filesystem
  // read (listAgentCommands), so these need an actual .claude/commands/*.md
  // fixture rather than a fully mocked agent.
  const workDir = mkdtempSync(join(tmpdir(), 'agentwaggle-skill-test-'));
  mkdirSync(join(workDir, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(workDir, '.claude', 'commands', 'ping.md'), '---\ndescription: test\n---\npong');
  after(() => rmSync(workDir, { recursive: true, force: true }));

  test('a hyphenated agent name is recognized as the skill-invocation target', () => {
    const a = { id: 'a', name: 'TP-Observer', workingDir: workDir };
    const result = parseSkillInvocation('@TP-Observer /ping', [a]);
    assert.deepEqual(result, { agent: a, command: '/ping' });
  });

  test('a longer hyphenated name is not shadowed by a shorter prefix agent name', () => {
    const short = { id: 'a', name: 'TP', workingDir: workDir };
    const long = { id: 'b', name: 'TP-Observer', workingDir: workDir };
    const result = parseSkillInvocation('@TP-Observer /ping', [short, long]);
    assert.equal(result.agent, long);
  });
});

describe('parseSkillInvocation — ALLOWED_BUILTIN_COMMANDS carve-out', () => {
  // No .claude/commands/compact.md or clear.md and no live process (so
  // getAgentSkills returns []) — /compact and /clear still resolve via
  // ALLOWED_BUILTIN_COMMANDS, unlike an arbitrary unregistered CLI built-in
  // such as /help.
  const workDir = mkdtempSync(join(tmpdir(), 'agentwaggle-compact-test-'));
  after(() => rmSync(workDir, { recursive: true, force: true }));

  test('/compact is recognized as a skill invocation despite not being a project command or reported skill', () => {
    const a = { id: 'a', name: 'Alice', workingDir: workDir };
    const result = parseSkillInvocation('@Alice /compact', [a]);
    assert.deepEqual(result, { agent: a, command: '/compact' });
  });

  test('/clear is recognized as a skill invocation despite not being a project command or reported skill', () => {
    const a = { id: 'a', name: 'Alice', workingDir: workDir };
    const result = parseSkillInvocation('@Alice /clear', [a]);
    assert.deepEqual(result, { agent: a, command: '/clear' });
  });

  test('an unrelated unregistered built-in like /help is still not forwarded', () => {
    const a = { id: 'a', name: 'Alice', workingDir: workDir };
    assert.equal(parseSkillInvocation('@Alice /help', [a]), null);
  });
});
