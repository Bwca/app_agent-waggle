/**
 * @fileoverview Unit tests for logTranscript (server/transcriptLog.js) —
 * the optional, opt-in plain-text log of exactly what's sent to and
 * received from each agent, for debugging without a real terminal.
 *
 * Off by default: APP_TRANSCRIPT_LOG must be set (any truthy value) for
 * anything to be written at all — checked fresh on every call, not cached
 * at module load, specifically so this file can toggle it directly rather
 * than needing a subprocess restart per test case.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logTranscript } from '../../server/transcriptLog.js';

let logDir;
let originalTranscriptEnv;
let originalLogDirEnv;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'agentwaggle-transcript-test-'));
  originalTranscriptEnv = process.env.APP_TRANSCRIPT_LOG;
  originalLogDirEnv = process.env.APP_LOG_DIR;
  process.env.APP_LOG_DIR = logDir;
});

afterEach(() => {
  if (originalTranscriptEnv === undefined) delete process.env.APP_TRANSCRIPT_LOG;
  else process.env.APP_TRANSCRIPT_LOG = originalTranscriptEnv;
  if (originalLogDirEnv === undefined) delete process.env.APP_LOG_DIR;
  else process.env.APP_LOG_DIR = originalLogDirEnv;
  rmSync(logDir, { recursive: true, force: true });
});

describe('logTranscript', () => {
  test('writes nothing at all when APP_TRANSCRIPT_LOG is unset', () => {
    delete process.env.APP_TRANSCRIPT_LOG;
    logTranscript({ chatId: 'chat1', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'SENT', content: 'hello' });
    assert.equal(existsSync(join(logDir, 'chats')), false, 'not even the chats/ directory should be created when disabled');
  });

  test('writes an entry to <APP_LOG_DIR>/chats/<chatId>.log when enabled', () => {
    process.env.APP_TRANSCRIPT_LOG = '1';
    logTranscript({ chatId: 'chat1', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'SENT', content: 'hello there' });
    const filePath = join(logDir, 'chats', 'chat1.log');
    assert.ok(existsSync(filePath), 'expected a per-chat log file to exist');
    const written = readFileSync(filePath, 'utf-8');
    assert.match(written, /Claudia \(a1\)/);
    assert.match(written, /stream s1/);
    assert.match(written, /SENT/);
    assert.match(written, /hello there/);
  });

  test('appends multiple entries to the same chat file, in order', () => {
    process.env.APP_TRANSCRIPT_LOG = '1';
    logTranscript({ chatId: 'chat1', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'SENT', content: 'first message' });
    logTranscript({ chatId: 'chat1', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'RECEIVED', content: 'first reply' });
    const written = readFileSync(join(logDir, 'chats', 'chat1.log'), 'utf-8');
    assert.ok(written.indexOf('first message') < written.indexOf('first reply'), 'entries should append in call order');
  });

  test('separate chats get separate files', () => {
    process.env.APP_TRANSCRIPT_LOG = '1';
    logTranscript({ chatId: 'chat-a', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'SENT', content: 'in chat A' });
    logTranscript({ chatId: 'chat-b', agentId: 'a1', agentName: 'Claudia', streamId: 's2', direction: 'SENT', content: 'in chat B' });
    const a = readFileSync(join(logDir, 'chats', 'chat-a.log'), 'utf-8');
    const b = readFileSync(join(logDir, 'chats', 'chat-b.log'), 'utf-8');
    assert.match(a, /in chat A/);
    assert.doesNotMatch(a, /in chat B/);
    assert.match(b, /in chat B/);
    assert.doesNotMatch(b, /in chat A/);
  });

  test('a ContentBlock[] array is rendered as plain text, with images noted rather than dumped', () => {
    process.env.APP_TRANSCRIPT_LOG = '1';
    const content = [
      { type: 'text', text: '[System]\nYou are Claudia' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-real-base64-data-that-should-never-appear' } },
      { type: 'text', text: 'take a look at this' },
    ];
    logTranscript({ chatId: 'chat1', agentId: 'a1', agentName: 'Claudia', streamId: 's1', direction: 'SENT', content });
    const written = readFileSync(join(logDir, 'chats', 'chat1.log'), 'utf-8');
    assert.match(written, /You are Claudia/);
    assert.match(written, /take a look at this/);
    assert.match(written, /\[image attached\]/);
    assert.doesNotMatch(written, /not-real-base64-data/, 'raw image data must never be dumped into the transcript');
  });
});
