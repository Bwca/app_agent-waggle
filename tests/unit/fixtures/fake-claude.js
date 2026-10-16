#!/usr/bin/env node
/**
 * @fileoverview A stand-in for the `claude` CLI, just enough of its
 * persistent stream-json mode for agentProcessManager.js: answers every
 * stdin line with a turn whose text is this process's pid and whose
 * session id is its `--resume` value (or "fresh"). Like the real CLI, it
 * takes a moment to exit after SIGTERM, which is the window the retiring
 * tests need. FAKE_CLAUDE_REPLY_DELAY_MS makes each turn take that long, so
 * a test can queue turns behind a busy one.
 */

const replyDelayMs = Number(process.env.FAKE_CLAUDE_REPLY_DELAY_MS) || 0;

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
    emit({ type: 'system', subtype: 'init' });
    setTimeout(() => {
      emit({ type: 'assistant', message: { id: `m${Date.now()}`, model: 'fake', content: [{ type: 'text', text: String(process.pid) }] } });
      emit({ type: 'result', is_error: false, result: String(process.pid) });
    }, replyDelayMs);
  }
});

process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300));
