/**
 * @fileoverview Shell-command parsing shared by every provider's permission
 * grants: what a granted command pattern covers is provider syntax, but how
 * a command line splits into the parts a user actually approved isn't.
 */

/**
 * Splits a command line on shell chaining operators (`&&`, `||`, `;`, `|`)
 * and returns each sub-command's first two whitespace-separated tokens
 * (e.g. "git add -A && git commit" -> ["git add", "git commit"]), deduped.
 * Two tokens rather than one keeps a grant from silently covering an entire
 * program: granting "git add" must never also authorize "git push --force".
 * An empty sub-command contributes an empty prefix, which a caller treats as
 * the bare tool.
 * @param {string} command
 * @returns {string[]}
 */
export function commandPrefixes(command) {
  const subCommands = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const prefixes = subCommands.map((cmd) => cmd.split(/\s+/).filter(Boolean).slice(0, 2).join(' '));
  return [...new Set(prefixes)];
}
