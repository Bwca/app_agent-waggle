/**
 * @fileoverview Unit tests for what granting a denied shell command saves
 * (commandGrants in server/services/providers/shellCommands.js, and
 * Claude's deriveToolPatterns on top of it).
 *
 * Reported live: approving one `python3 -c 'print(...)'` saved
 * `Bash(python3 -c:*)`, approving a mouse-wiggle loop saved `Bash(for i:*)`,
 * `Bash(do xdotool:*)` and `Bash(done:*)`, and approving the wiggle itself
 * saved `Bash(xdotool mousemove:*)`, which also covers clicking Grant on the
 * agent's own next permission card. A few clicks turned a non-YOLO agent
 * into a mostly-YOLO one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { commandGrants } from '../../server/services/providers/shellCommands.js';
import { deriveToolPatterns } from '../../server/services/providers/claude.js';
import { decidePermission as cursorDecides } from '../../server/services/providers/cursor.js';

describe('commandGrants', () => {
  test('an ordinary chain is granted by two-token prefixes', () => {
    assert.deepEqual(deriveToolPatterns('Bash', 'git add -A && git commit -m x'), ['Bash(git add:*)', 'Bash(git commit:*)']);
  });

  test('an interpreter running inline code is granted exactly', () => {
    assert.deepEqual(deriveToolPatterns('Bash', `python3 -c 'print("hi")'`), [`Bash(python3 -c 'print("hi")')`]);
    assert.deepEqual(deriveToolPatterns('Bash', 'node -e "console.log(1)"'), ['Bash(node -e "console.log(1)")']);
    assert.deepEqual(deriveToolPatterns('Bash', 'bash -c "rm -rf x"'), ['Bash(bash -c "rm -rf x")']);
  });

  test('wrappers, assignments and substitutions are granted exactly', () => {
    for (const command of ['sudo apt update', 'xargs rm', 'find . -name x', 'FOO=1 rm -rf x', 'eval $(ssh-agent)', 'echo `whoami`', '/usr/bin/python3.12 x.py']) {
      assert.deepEqual(commandGrants(command), [{ text: command, exact: true }], command);
    }
  });

  test('mouse and keyboard tools are granted exactly', () => {
    assert.deepEqual(deriveToolPatterns('Bash', 'xdotool mousemove 60 0'), ['Bash(xdotool mousemove 60 0)']);
  });

  test('a loop is granted by the commands inside it, never by its keywords', () => {
    const patterns = deriveToolPatterns('Bash', 'for i in 1 2 3; do xdotool mousemove_relative 60 0; sleep 0.08; done');
    assert.deepEqual(patterns, ['Bash(xdotool mousemove_relative 60 0)', 'Bash(sleep 0.08:*)']);
    assert.deepEqual(deriveToolPatterns('Bash', 'if [ -f x ]; then cat x; fi'), ['Bash([ -f x ])', 'Bash(cat x:*)']);
  });

  test('separators inside quotes and redirections do not split a command', () => {
    assert.deepEqual(commandGrants(`python3 -c 'print("a|b; c")'`), [{ text: `python3 -c 'print("a|b; c")'`, exact: true }]);
    assert.deepEqual(commandGrants('npm test 2>&1 | grep FAIL'), [{ text: 'npm test', exact: false }, { text: 'grep FAIL', exact: false }]);
  });

  test('newlines separate commands', () => {
    assert.deepEqual(commandGrants('git status\nmake build'), [{ text: 'git status', exact: false }, { text: 'make build', exact: false }]);
  });
});

// Found in review: each of these still saved a prefix rule covering far
// more than the command shown on the card.
describe('commandGrants, reviewed cases', () => {
  test('a heredoc is granted whole, never its body as commands', () => {
    const command = 'cat <<EOF > f.txt\nrm -rf thing\nEOF';
    assert.deepEqual(commandGrants(command), [{ text: command, exact: true }]);
    assert.deepEqual(commandGrants("python3 - <<'PY'\nimport os\nos.system('id')\nPY").length, 1);
  });

  test('a here-string is not a heredoc', () => {
    assert.deepEqual(commandGrants('grep x <<< "a b"'), [{ text: 'grep x', exact: false }]);
  });

  test('a flag as the second word is granted exactly', () => {
    for (const command of ['git -c core.sshCommand=x fetch', 'npx -y foo', 'vim -c ":!id"', 'make -C /tmp', 'java -jar x.jar', 'sed -n 1p x']) {
      assert.deepEqual(commandGrants(command), [{ text: command, exact: true }], command);
    }
  });

  test('programs that run a package or another program are granted exactly', () => {
    for (const command of ['npx foo', 'uvx foo', 'npm exec foo', 'pnpm dlx foo', 'docker run alpine', 'podman run x', 'go run .', 'git config core.pager x', 'dotool type x', 'nvim x']) {
      assert.deepEqual(commandGrants(command), [{ text: command, exact: true }], command);
    }
    assert.deepEqual(commandGrants('npm test'), [{ text: 'npm test', exact: false }]);
  });

  test('a program name hidden by quotes, a backslash or a variable is granted exactly', () => {
    for (const command of ["pyth''on3 -c x", '\\python3 -c x', '$CMD arg', '${X} arg']) {
      assert.deepEqual(commandGrants(command), [{ text: command, exact: true }], command);
    }
  });

  test('a subshell\'s brackets are not part of its commands', () => {
    assert.deepEqual(deriveToolPatterns('Bash', '(cd /tmp && ls)'), ['Bash(cd /tmp:*)', 'Bash(ls:*)']);
  });
});

describe('cursor decidePermission with exact grants', () => {
  const agent = (patterns) => ({ workingDir: '/w', allowedToolPatterns: patterns });
  const call = (command) => ({ tool_name: 'Shell', tool_use_id: 'x', tool_input: { command } });

  test('an exact grant covers only that command', () => {
    const granted = agent([`Shell(python3 -c 'print(1)')`]);
    assert.equal(cursorDecides(granted, call(`python3 -c 'print(1)'`)), true);
    assert.equal(cursorDecides(granted, call(`python3 -c 'print(2)'`)), false);
  });

  test('a prefix grant still covers the same command with a flag, like a Claude Bash pattern', () => {
    assert.equal(cursorDecides(agent(['Shell(date:*)']), call('date -u')), true);
  });
});
