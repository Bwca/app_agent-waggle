#!/usr/bin/env node
/**
 * @fileoverview A stand-in for the `claude` CLI, just enough of its
 * persistent stream-json mode for agentProcessManager.js: answers every
 * stdin line with a turn whose text is this process's pid and whose
 * session id is its `--resume` value (or "fresh"). Like the real CLI, it
 * takes a moment to exit after SIGTERM, which is the window the retiring
 * tests need. FAKE_CLAUDE_REPLY_DELAY_MS makes each turn take that long, so
 * a test can queue turns behind a busy one. FAKE_CLAUDE_REPLY replaces the
 * reply text (see "{turn}" below), and FAKE_CLAUDE_PROMPT_DIR records each turn's stdin line as
 * `<cwd basename>-<turn number>.json` there.
 */

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const replyDelayMs = Number(process.env.FAKE_CLAUDE_REPLY_DELAY_MS) || 0;
const promptDir = process.env.FAKE_CLAUDE_PROMPT_DIR;
let turnNumber = 0;

const resumeArg = process.argv.find((arg) => arg.startsWith('--resume='));
const sessionId = resumeArg ? resumeArg.slice('--resume='.length) : 'fresh';
const emit = (event) => process.stdout.write(JSON.stringify({ ...event, session_id: sessionId }) + '\n');

let buffered = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    turnNumber++;
    if (promptDir) writeFileSync(join(promptDir, `${basename(process.cwd())}-${process.pid}-${turnNumber}.json`), line);
    // "{turn}" in FAKE_CLAUDE_REPLY becomes `<pid>-<turn number>`, so each
    // reply is distinguishable.
    const reply = (process.env.FAKE_CLAUDE_REPLY || String(process.pid)).replace('{turn}', `${process.pid}-${turnNumber}`);
    emit({ type: 'system', subtype: 'init' });
    setTimeout(() => {
      emit({ type: 'assistant', message: { id: `m${Date.now()}-${turnNumber}`, model: 'fake', content: [{ type: 'text', text: reply }] } });
      emit({ type: 'result', is_error: false, result: reply });
    }, replyDelayMs);
  }
});

process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300));
