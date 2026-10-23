#!/usr/bin/env node
/**
 * @fileoverview A stand-in for the `claude` CLI, just enough of its
 * persistent stream-json mode for agentProcessManager.js: answers every
 * stdin line with a turn whose text is this process's pid and whose
 * session id is its `--resume` value (or "fresh"). Like the real CLI, it
 * takes a moment to exit after SIGTERM, which is the window the retiring
 * tests need. FAKE_CLAUDE_REPLY_DELAY_MS makes each turn take that long, so
 * a test can queue turns behind a busy one. A bare "/clear" or "/compact"
 * turn is answered the way the real CLI does. FAKE_CLAUDE_REPLY replaces the
 * reply text (see "{turn}" below), and FAKE_CLAUDE_PROMPT_DIR records each turn's stdin line as
 * `<cwd basename>-<turn number>.json` there. FAKE_CLAUDE_ARGS_DIR records
 * this process's command-line arguments as `<cwd basename>-<pid>.json`.
 * SIGINT (a stop) ends a turn in progress the way CLI 2.1.301 does, with an
 * is_error result and exit code 0; FAKE_CLAUDE_SIGINT_EXIT_CODE makes it
 * exit with that code instead, without a result, like a CLI that just dies.
 */

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const replyDelayMs = Number(process.env.FAKE_CLAUDE_REPLY_DELAY_MS) || 0;
const promptDir = process.env.FAKE_CLAUDE_PROMPT_DIR;
let turnNumber = 0;
/** The reply timer of the turn in progress, if any. */
let pendingReply = null;
if (process.env.FAKE_CLAUDE_ARGS_DIR) {
  writeFileSync(join(process.env.FAKE_CLAUDE_ARGS_DIR, `${basename(process.cwd())}-${process.pid}.json`), JSON.stringify(process.argv.slice(2)));
}

const resumeArg = process.argv.find((arg) => arg.startsWith('--resume='));
let sessionId = resumeArg ? resumeArg.slice('--resume='.length) : 'fresh';
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
    // A bare "/clear" or "/compact" is answered the way CLI 2.1.301 does:
    // no assistant text, just the reset or the compaction, and an empty
    // result.
    const text = JSON.parse(line).message?.content?.at?.(-1)?.text;
    if (text === '/clear') {
      emit({ type: 'conversation_reset' });
      sessionId = `cleared-${process.pid}-${turnNumber}`;
      emit({ type: 'system', subtype: 'init' });
      emit({ type: 'result', is_error: false, result: '', num_turns: 0 });
      continue;
    }
    if (text === '/compact') {
      emit({ type: 'system', subtype: 'status', status: 'compacting' });
      emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      emit({ type: 'system', subtype: 'init' });
      emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 19249, post_tokens: 1840 } });
      emit({ type: 'result', is_error: false, result: '', num_turns: 0 });
      continue;
    }
    emit({ type: 'system', subtype: 'init' });
    pendingReply = setTimeout(() => {
      pendingReply = null;
      emit({ type: 'assistant', message: { id: `m${Date.now()}-${turnNumber}`, model: 'fake', content: [{ type: 'text', text: reply }] } });
      emit({ type: 'result', is_error: false, result: reply });
    }, replyDelayMs);
  }
});

process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300));
process.on('SIGINT', () => {
  const exitCode = process.env.FAKE_CLAUDE_SIGINT_EXIT_CODE;
  if (exitCode) process.exit(Number(exitCode));
  if (pendingReply) {
    clearTimeout(pendingReply);
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] });
  }
  process.exit(0);
});
