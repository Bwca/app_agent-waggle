/**
 * @fileoverview Unit tests for dedupePermissionDenials (server/services/agentRunner.js)
 * — a pure function, no `claude` subprocess involved.
 *
 * Reported live: a permission card showing "node --version && npm --version"
 * and, right below it, a separate "npm --version" row — both needing their
 * own Grant/Deny click even though granting the first already authorizes
 * the second (deriveToolPatterns splits a chained command into one pattern
 * per sub-command, so "npm --version" alone is already covered). Same shape
 * for a piped "cmd | tail -60" followed by the same command unpiped.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dedupePermissionDenials } from '../../server/services/agentRunner.js';

function denial(toolName, value) {
  return { tool_name: toolName, tool_use_id: 'x', tool_input: toolName === 'Bash' ? { command: value } : { file_path: value } };
}

describe('dedupePermissionDenials', () => {
  test('a standalone command already covered by an earlier chained one is dropped', () => {
    const denials = [
      denial('Bash', 'node --version && npm --version'),
      denial('Bash', 'npm --version'),
    ];
    const result = dedupePermissionDenials(denials);
    assert.equal(result.length, 1, `expected the redundant standalone row to be dropped, got: ${JSON.stringify(result)}`);
    assert.equal(result[0].tool_input.command, 'node --version && npm --version');
  });

  test('an unpiped command already covered by an earlier piped one is dropped', () => {
    const piped = 'npm run build 2>&1 | tail -60';
    const unpiped = 'npm run build';
    const result = dedupePermissionDenials([denial('Bash', piped), denial('Bash', unpiped)]);
    assert.equal(result.length, 1, `expected the redundant unpiped row to be dropped, got: ${JSON.stringify(result)}`);
    assert.equal(result[0].tool_input.command, piped);
  });

  test('a chained command NOT fully covered by an earlier standalone one is kept', () => {
    // "npm --version" alone only covers Bash(npm --version:*) — the later
    // chain also needs Bash(node --version:*), which is still ungranted, so
    // it must still be shown (granting it will re-derive/re-grant both
    // patterns, harmlessly re-covering "npm --version" too).
    const denials = [
      denial('Bash', 'npm --version'),
      denial('Bash', 'node --version && npm --version'),
    ];
    const result = dedupePermissionDenials(denials);
    assert.equal(result.length, 2, `expected both rows to survive, got: ${JSON.stringify(result)}`);
  });

  test('genuinely unrelated Bash commands are both kept', () => {
    const result = dedupePermissionDenials([denial('Bash', 'git push origin main'), denial('Bash', 'rm file.txt')]);
    assert.equal(result.length, 2);
  });

  test('exact duplicate denials (any tool) are still collapsed to one', () => {
    const result = dedupePermissionDenials([denial('Bash', 'git add -A'), denial('Bash', 'git add -A')]);
    assert.equal(result.length, 1);
  });

  test('file-path tools are never pattern-collapsed — two different files both survive', () => {
    // deriveToolPatterns has no real pattern for file-path tools (just
    // returns the bare tool name), so treating that as a comparable
    // "pattern" would wrongly hide a second, different file's denial.
    const result = dedupePermissionDenials([denial('Write', '/tmp/a.txt'), denial('Write', '/tmp/b.txt')]);
    assert.equal(result.length, 2, `both distinct files must survive, got: ${JSON.stringify(result)}`);
  });

  test('an empty list stays empty', () => {
    assert.deepEqual(dedupePermissionDenials([]), []);
  });
});
