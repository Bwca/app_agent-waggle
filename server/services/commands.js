/**
 * @fileoverview Lists an agent's custom slash commands, read straight from
 * its project's command directory (`.claude/commands/*.md` for Claude; each
 * provider names its own, see AgentProvider.commandDirs) — the same
 * mechanism `parseSkillInvocation` (messageRouter.js) relies on to actually
 * invoke one. Used to power the composer's slash-command autocomplete;
 * purely a filesystem read, no `claude` subprocess involved.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * CLI built-in local commands (present in the `claude` process's
 * `system/init` event as `slash_commands`, never in its separate `skills`
 * array — getAgentSkills only ever captures the latter, see
 * agentProcessManager.js's `init` handling) that are safe to expose anyway.
 * `compact` and `clear` are the two exceptions: unlike a generic meta-command
 * such as `/help`, a user only ever invokes either against an agent that's
 * already deep into a resumed session — i.e. long past the point where its
 * one-time identity preamble (buildSystemPreamble in ws/handler.js) would
 * have gone out — so the preamble-discarding collision messageRouter.js's
 * parseSkillInvocation gate exists to prevent doesn't apply here in
 * practice.
 *
 * `clear` carries a second risk `compact` doesn't: it genuinely rotates the
 * CLI's underlying session_id (confirmed directly against the installed
 * binary — see agentProcessManager.js's conversation_reset handling), which
 * would collide with this app's "only capture resumeId once" assumption
 * (setAgentResumeIdIfUnset) if left unhandled — ws/handler.js's turn
 * completion specifically detects this and calls store/db.js's
 * recordContextClear instead, which overwrites resumeId unconditionally and
 * stamps contextResetAt so the next turn re-sends a full system preamble
 * rather than trusting now-stale --resume memory.
 *
 * Shared between that gate and mergeSkills below so the composer's
 * autocomplete never offers a command parseSkillInvocation would then
 * refuse to forward.
 */
export const ALLOWED_BUILTIN_COMMANDS = new Set(['compact', 'clear']);

/**
 * @typedef {Object} SlashCommand
 * @property {string} name - The command's invocable name, e.g. "echo-test"
 *   for `.claude/commands/echo-test.md` (invoked as "/echo-test").
 * @property {string | null} description - Parsed from the file's YAML
 *   frontmatter `description:` field, if present. Always null for a
 *   `builtin` entry — the CLI's own init event reports names only.
 * @property {boolean} builtin - True for a CLI skill (built-in, or from an
 *   installed marketplace/plugin) reported by the agent's own live process,
 *   as opposed to a project-level `.claude/commands/*.md` file.
 */

/**
 * Extracts the `description:` value from a command file's leading YAML
 * frontmatter block (`---\n...\n---`), if any. Deliberately lenient — this
 * only needs the one field for display purposes, not a full YAML parse, and
 * a command file without frontmatter (or without a description) is common
 * and not an error.
 * @param {string} raw - The full file contents
 * @returns {string | null}
 */
function parseFrontmatterDescription(raw) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const descLine = frontmatter[1].split(/\r?\n/).find((line) => /^description:/.test(line.trim()));
  if (!descLine) return null;
  return descLine.slice(descLine.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || null;
}

/**
 * Lists the custom slash commands available to an agent working in
 * `workingDir` — every `.md` file directly inside its provider's command
 * directories (`.claude/commands/` by default; project-level only, not
 * recursing into subdirectories, and not including any user-level
 * `~/.claude/commands/` — see file header for why that's an acceptable
 * scope for now). A directory that doesn't exist contributes nothing,
 * rather than being an error — most agents won't have any custom commands
 * defined. The first directory wins a name both define.
 * @param {string} workingDir
 * @param {string[]} [dirs] - Paths relative to workingDir, from the agent's
 *   provider (AgentProvider.commandDirs).
 * @returns {SlashCommand[]} Sorted alphabetically by name
 */
export function listAgentCommands(workingDir, dirs = ['.claude/commands']) {
  const commands = new Map();
  for (const relative of dirs) {
    for (const command of listCommandDir(join(workingDir, relative))) {
      if (!commands.has(command.name)) commands.set(command.name, command);
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} dir
 * @returns {SlashCommand[]}
 */
function listCommandDir(dir) {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const name = f.slice(0, -3);
      let description = null;
      try {
        description = parseFrontmatterDescription(readFileSync(join(dir, f), 'utf-8'));
      } catch {
        // Unreadable file (permissions, race with a concurrent delete, etc.)
        // — still list the command by name, just without a description.
      }
      return { name, description, builtin: false };
    });
}

/**
 * Merges an agent's project-level commands with its live process's
 * reported CLI skill names into one alphabetical list for the composer's
 * "/" autocomplete — project commands win on a name collision (they carry
 * a description; a same-named builtin entry would be redundant).
 *
 * Also always includes ALLOWED_BUILTIN_COMMANDS (e.g. "/compact") even
 * though it never appears in builtinSkillNames — that list comes from the
 * CLI's `skills` init field, which deliberately excludes true built-ins
 * like compact (they live in the separate `slash_commands` field instead,
 * which this project doesn't otherwise track). Without this, a command
 * parseSkillInvocation already special-cases as forwardable would still be
 * invisible in the autocomplete dropdown, with no way to discover it short
 * of knowing it existed already.
 * @param {SlashCommand[]} projectCommands - From listAgentCommands.
 * @param {string[]} builtinSkillNames - From agentProcessManager's
 *   getAgentSkills.
 * @param {Set<string>} [alwaysOffered] - The provider's own built-ins that
 *   are always forwardable (AgentProvider.builtinCommands).
 * @returns {SlashCommand[]} Sorted alphabetically by name.
 */
export function mergeSkills(projectCommands, builtinSkillNames, alwaysOffered = ALLOWED_BUILTIN_COMMANDS) {
  const projectNames = new Set(projectCommands.map((c) => c.name));
  const builtinNames = new Set([...builtinSkillNames, ...alwaysOffered]);
  const builtins = [...builtinNames]
    .filter((name) => !projectNames.has(name))
    .map((name) => ({ name, description: null, builtin: true }));
  return [...projectCommands, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
}
