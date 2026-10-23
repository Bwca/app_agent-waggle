/**
 * @fileoverview Shell-command parsing shared by every provider's permission
 * grants: what a granted command pattern covers is provider syntax, but how
 * a command line splits into the parts a user actually approved isn't.
 */

/**
 * @typedef {Object} CommandGrant
 * @property {string} text - A two-token prefix, or a whole sub-command when
 *   `exact` is set.
 * @property {boolean} exact - Grant exactly this sub-command, never anything
 *   starting with it.
 */

// Programs whose first two tokens say nothing about what will run:
// interpreters ("python3 -c" covers any Python at all), shells, and wrappers
// that run another command they're given ("sudo rm", "xargs sh", "find .
// -exec"). Reported live: one approved `python3 -c 'print(...)'` saved
// `Bash(python3 -c:*)`, pre-approving every Python program from then on.
// Tools that drive the mouse and keyboard are here too: a saved
// `xdotool mousemove:*` also covers `xdotool mousemove X Y click 1`, which
// can click Grant on the agent's own next permission card.
const OPAQUE_PROGRAMS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'luajit', 'Rscript', 'osascript', 'awk', 'gawk', 'tclsh', 'pwsh',
  'eval', 'exec', 'source', '.', 'command', 'builtin', 'sudo', 'doas', 'su', 'env', 'nohup', 'nice', 'timeout', 'time',
  'xargs', 'parallel', 'watch', 'find', 'ssh', 'script', 'setsid', 'stdbuf', 'unbuffer', 'strace', 'chroot', 'flock',
  'npx', 'uvx', 'bunx', 'pipx', 'podman', 'java', 'vi', 'vim', 'nvim', 'emacs',
  'xdotool', 'ydotool', 'dotool', 'wtype', 'xte', 'cliclick',
]);
const OPAQUE_PROGRAM_PATTERN = /^(python|pypy)[\d.]*$/;
// Two-word prefixes that run whatever comes after them, where the program
// alone is otherwise fine to grant by prefix ("npm test" is the project's
// own script, "npm exec" is any package).
const OPAQUE_PREFIXES = new Set([
  'npm exec', 'pnpm dlx', 'pnpm exec', 'yarn dlx', 'yarn exec', 'docker run', 'docker exec', 'go run', 'cargo run', 'git config',
]);

// Words that start or continue a compound command. The CLI judges a loop
// or conditional by the commands inside it (checked live: `Bash(for i:*)`
// and `Bash(done:*)` never allowed a loop, an exact rule for the inner
// command did), so these are stripped to find that command, and a part
// that's nothing but structure is dropped.
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(']);
const STRUCTURE_ONLY = /^(for|select|case|done|fi|esac|in|\}|\)|;;)(\s|$)/;


/**
 * Splits a command line on shell chaining operators (`&&`, `||`, `;`, `|`,
 * `&`) and newlines, outside quotes.
 * @param {string} command
 * @returns {string[]}
 */
function splitSubCommands(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += ch + command[++i];
      else {
        if (ch === quote) quote = null;
        current += ch;
      }
    } else if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i];
    } else if (ch === '&' && (/[<>]$/.test(current) || command[i + 1] === '>')) {
      current += ch; // a redirection like 2>&1 or &>, not a separator
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      parts.push(current);
      current = '';
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Strips leading compound-command keywords from a sub-command ("do xdotool
 * click 1" -> "xdotool click 1"), or returns '' for a part that is only
 * structure ("done", "for i in 1 2 3").
 * @param {string} subCommand
 * @returns {string}
 */
function innerCommand(subCommand) {
  let cmd = subCommand;
  for (;;) {
    if (STRUCTURE_ONLY.test(cmd)) return '';
    // A subshell or group's opening bracket can sit right against its
    // first command: "(cd /tmp && ls)".
    if (/^[({]\S/.test(cmd)) {
      cmd = cmd.slice(1);
      continue;
    }
    const [first] = cmd.split(/\s+/, 1);
    if (!LEADING_KEYWORDS.has(first)) break;
    cmd = cmd.slice(first.length).trim();
  }
  // ...and its closing one against its last: "ls)".
  while (/[)}]$/.test(cmd) && count(cmd, ')') + count(cmd, '}') > count(cmd, '(') + count(cmd, '{')) cmd = cmd.slice(0, -1).trim();
  return cmd;
}

/**
 * @param {string} text
 * @param {string} ch
 * @returns {number}
 */
function count(text, ch) {
  return text.split(ch).length - 1;
}

/**
 * Whether a sub-command must be granted exactly rather than by prefix: its
 * program is opaque (see OPAQUE_PROGRAMS, OPAQUE_PREFIXES), its second word
 * is a flag ("git -c", "vim -c", "sed -n": what the flag does decides what
 * runs, and the prefix can't say), its program is spelled in a way a plain
 * name check can't see through (`pyth''on3`, `\python3`, `$CMD`), it starts
 * with variable assignments (which can hide any program behind them), or it
 * runs another command through a substitution.
 * @param {string} cmd
 * @returns {boolean}
 */
function needsExactGrant(cmd) {
  if (/\$\(|`|<\(|>\(/.test(cmd)) return true;
  const [first, second = ''] = cmd.split(/\s+/, 2);
  if (/^[A-Za-z_]\w*=/.test(first) || /['"\\$]/.test(first)) return true;
  if (second.startsWith('-')) return true;
  const program = first.replace(/^.*\//, '');
  return OPAQUE_PROGRAMS.has(program) || OPAQUE_PROGRAM_PATTERN.test(program) || OPAQUE_PREFIXES.has(`${program} ${second}`);
}

/**
 * The commands a command line runs, as a permission check sees them: split
 * on chaining operators and newlines, with loop and conditional keywords
 * stripped (see innerCommand). A command with a heredoc is one part, whole:
 * its body is data, not commands, and splitting it on newlines granted
 * whatever text it held ("rm -rf thing" written to a file became
 * `Bash(rm -rf:*)`).
 * @param {string} command
 * @returns {string[]}
 */
export function commandParts(command) {
  if (/(^|[^<])<<(?!<)/.test(command)) {
    const text = command.trim();
    return text ? [text] : [];
  }
  return splitSubCommands(command).map(innerCommand).filter(Boolean);
}

/**
 * What granting a command line authorizes, one entry per part (see
 * commandParts), deduped: usually its first two whitespace-separated
 * tokens ("git add -A && git commit" -> "git add", "git commit"), which
 * keeps a grant from silently covering an entire program (granting "git
 * add" must never also authorize "git push --force"). A part whose prefix
 * wouldn't say what runs (see needsExactGrant), or a command with a
 * heredoc, is granted exactly instead.
 * @param {string} command
 * @returns {CommandGrant[]}
 */
export function commandGrants(command) {
  const heredoc = /(^|[^<])<<(?!<)/.test(command);
  const seen = new Set();
  const grants = [];
  for (const cmd of commandParts(command)) {
    const exact = heredoc || needsExactGrant(cmd);
    const text = exact ? cmd : cmd.split(/\s+/).slice(0, 2).join(' ');
    const key = `${exact}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push({ text, exact });
  }
  return grants;
}
