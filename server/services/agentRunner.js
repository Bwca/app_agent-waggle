/**
 * @fileoverview Permission-pattern utilities shared by the WS handler, plus
 * runAgentStream — the entry point for running one turn against an agent.
 * File-tool access is scoped to the agent's workingDir plus any
 * extraAllowedPaths; non-file tool calls (Bash, etc.) are separately scoped
 * via allowedToolPatterns.
 *
 * Actually talking to the agent's CLI (spawning, keeping a process alive across
 * turns, stream-json parsing) lives in agentProcessManager.js — every
 * agent gets ONE persistent process for as long as it's in a chat, instead
 * of a fresh one-shot process per turn, so MCP servers (and anything else
 * expensive to establish) survive across turns rather than being torn down
 * and reconnected on every single message. runAgentStream below just
 * delegates to it, keeping its own external contract unchanged so callers
 * don't need to know or care.
 */

import { spawn } from 'child_process';
import { runTurn } from './agentProcessManager.js';
import { getProvider } from './providers/index.js';
import { t } from '../i18n/t.js';

// Tool names whose permission_denials carry a real filesystem path
// (tool_input.file_path) — these are the ones `extraAllowedPaths`/`--add-dir`
// can actually authorize. Anything else (Bash, WebFetch, etc.) needs
// allowedToolPatterns/`--allowedTools` instead — see the Agent typedef in
// db.js for why the two grant mechanisms are kept separate.
export const FILE_PATH_TOOLS = ['Write', 'Edit', 'Read', 'NotebookEdit'];

/**
 * Derives the scoped `--allowedTools` pattern(s) to grant for a denied,
 * non-file-path tool call. Called server-side (handler.js's GRANT_PERMISSION
 * handler) on the same flattened "value" string the permission card already
 * displays — the client never needs to know about tool-pattern syntax.
 *
 * For Bash: acceptEdits denies a chained command (`a && b`, `a; b`, `a | b`)
 * outright as "multiple operations" — the denial's tool_input.command is the
 * FULL chained string, not just whichever sub-command actually needed
 * approval. Granting only a pattern derived from the first sub-command would
 * silently fail to unblock a later sub-command that isn't first in the chain
 * (this was caught by this feature's own regression test). So: split on
 * shell chaining operators and derive one pattern per sub-command, each as
 * its first two whitespace-separated tokens (e.g. "git add ..." -> "Bash(git
 * add:*)"), confirmed empirically against the real `claude` CLI (v2.1.220).
 * Two tokens rather than one keeps a grant from silently covering an entire
 * tool (granting "git add" must never also authorize "git push --force") —
 * granting every sub-command of a chain the user explicitly saw and approved
 * is correct, since that's exactly what the permission card displayed.
 *
 * For any other non-file tool (WebFetch, WebSearch, Task, ...), Claude Code's
 * permission patterns don't support this kind of sub-command scoping — the
 * bare tool name is the only granted form.
 * @param {string} toolName
 * @param {string} value - The denial's flattened display value (a Bash
 *   command string, or JSON.stringify(tool_input) for anything else)
 * @returns {string[]}
 */
export function deriveToolPatterns(toolName, value) {
  if (toolName !== 'Bash') return [toolName];
  const subCommands = value.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const patterns = subCommands.map((cmd) => {
    const tokens = cmd.split(/\s+/).filter(Boolean);
    const prefix = tokens.slice(0, 2).join(' ');
    return prefix ? `Bash(${prefix}:*)` : 'Bash';
  });
  return [...new Set(patterns)];
}

/**
 * Narrows a turn's raw permission_denials down to genuinely distinct asks.
 * The model can retry a blocked Bash action more than once in the same turn
 * with different literal text that still derives an OVERLAPPING or subset
 * pattern set — a chained "node --version && npm --version" then a
 * standalone "npm --version", or a piped "cmd | tail -60" then the same
 * command unpiped. Both members of each pair were reported by a user as
 * confusing "duplicate" permission rows: granting the first already covers
 * the second via deriveToolPatterns, so asking for it again is pure
 * redundancy, not a genuinely separate authorization.
 *
 * Deliberately scoped to Bash only. For file-path tools (Write/Edit/Read/
 * NotebookEdit), deriveToolPatterns has no real pattern to compare — it
 * just returns the bare tool name — so two DIFFERENT files would both
 * collapse to the same "pattern", which would wrongly hide a second,
 * legitimately different file's permission request. Exact tool+value
 * duplicates are still caught for every tool, matching the client's own
 * dedupe (buildPermissionCard) — this just adds the Bash-specific
 * subset case on top, since only the server knows CLI pattern syntax.
 * @param {PermissionDenial[]} denials
 * @returns {PermissionDenial[]}
 */
export function dedupePermissionDenials(denials) {
  const kept = [];
  const seenExact = new Set();
  const coveredBashPatterns = new Set();

  for (const denial of denials) {
    const value = String(denial.tool_input?.file_path ?? denial.tool_input?.command ?? JSON.stringify(denial.tool_input));
    const exactKey = `${denial.tool_name}::${value}`;
    if (seenExact.has(exactKey)) continue;

    if (denial.tool_name === 'Bash') {
      const patterns = deriveToolPatterns('Bash', value);
      if (patterns.length && patterns.every((p) => coveredBashPatterns.has(p))) continue;
      for (const p of patterns) coveredBashPatterns.add(p);
    }

    seenExact.add(exactKey);
    kept.push(denial);
  }

  return kept;
}

/**
 * @typedef {Object} PermissionDenial
 * @property {string} tool_name   - Tool that was blocked (e.g. "Write", "Bash")
 * @property {string} tool_use_id - ID of the specific tool call
 * @property {Record<string, unknown>} tool_input - The full tool input (file_path, command, etc.)
 */

/**
 * @typedef {Object} AgentRunResult
 * @property {string} text - The full response text
 * @property {PermissionDenial[]} permissionDenials - Any tool calls that were blocked
 * @property {string | null} sessionId - The Claude CLI's session_id captured from this
 *   run's stream events, for resuming this agent's native session on future turns.
 *   Null if no event carrying a session_id was ever parsed (e.g. the process crashed
 *   before producing any output).
 * @property {boolean} stopped - True if this result came from the user aborting the
 *   run mid-turn (via `signal`) rather than the CLI finishing on its own.
 * @property {import('./agentProcessManager.js').ToolCall[]} toolCalls - Every
 *   tool call made during this turn, paired with its own result — lets the
 *   UI show what a tool actually returned (a diff, command output, an MCP
 *   response), collapsed by default, without cluttering the main reply.
 * @property {boolean} wasLocalCommand - True if the `claude` CLI's own
 *   local-command dispatcher (not this project's skill mechanism)
 *   intercepted this turn before the model saw it — see
 *   agentProcessManager.js's createTurnAccumulator and
 *   db.js's Message.isLocalCommandOnly for why callers need this.
 * @property {boolean} contextCleared - True if this turn was a bare
 *   "/clear" the CLI's own local-command dispatcher intercepted — a
 *   DIFFERENT wire shape than wasLocalCommand above (no synthetic assistant
 *   message; a "system"/"conversation_reset" event instead), and one that
 *   genuinely rotates `sessionId` to a brand-new CLI session rather than
 *   just intercepting a turn within the existing one. See
 *   agentProcessManager.js's createTurnAccumulator and
 *   store/db.js's recordContextClear for why callers need this distinct
 *   from wasLocalCommand.
 * @property {import('./agentProcessManager.js').TurnUsage | null} usage - Token
 *   accounting for this turn straight from the CLI's own `result` event.
 * @property {number | null} contextTokens - The session's context size as of
 *   this turn's last model request — see createTurnAccumulator's docs for
 *   why this isn't derivable from `usage`.
 * @property {number | null} totalCostUsd - The CLI's own cost estimate for this turn.
 * @property {number | null} durationMs - Wall-clock turn duration per the CLI.
 * @property {string | null} model - The real model ID the CLI reported actually
 *   running this turn on (e.g. "claude-sonnet-5") — this app never requests a
 *   model itself, so this is purely observational. Null for a turn with no
 *   real assistant event (a local command, or a crash before any output).
 * @property {{ trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[]} compactions -
 *   Every context-compaction the CLI's own --autocompact (or a manual
 *   /compact) reported during this turn — see
 *   agentProcessManager.js's createTurnAccumulator. Usually empty.
 */

/**
 * @typedef {Object} TextBlock
 * @property {'text'} type
 * @property {string} text
 */

/**
 * @typedef {Object} ImageBlock
 * @property {'image'} type
 * @property {{ type: 'base64', media_type: string, data: string }} source
 */

/**
 * @typedef {TextBlock | ImageBlock} ContentBlock
 */

/**
 * @typedef {Object} RunAgentStreamOptions
 * @property {import('../store/db.js').Agent} agent - The agent to run
 * @property {string} chatId - The chat context (for logging)
 * @property {ContentBlock[]} content - Full message content, including conversation context
 * @property {string} streamId - Unique ID for this streaming response
 * @property {(text: string) => void} onChunk - Called with each text delta
 * @property {(status: string) => void} [onStatus] - Called whenever the agent
 *   starts a new tool call, with a short human label (e.g. "Reading app.js")
 * @property {AbortSignal} [signal] - When aborted, kills the underlying
 *   `claude` process (SIGTERM) and resolves with whatever partial output was
 *   captured so far instead of rejecting. Confirmed empirically that a plain
 *   SIGTERM to just the direct child is enough — the CLI tears down its own
 *   in-flight Bash tool subprocess too, no process-group tricks needed.
 */

/**
 * Runs one turn for an agent, against its persistent process — spawning it
 * first if this is the agent's first turn since joining the chat (or since
 * a prior process was evicted, e.g. by a stop/crash/grant). See
 * agentProcessManager.js for --add-dir/--permission-mode/--allowedTools/
 * --resume reasoning (unchanged from before this file's refactor) and for
 * how a turn is queued, streamed, and resolved against a long-lived
 * process instead of a fresh one-shot spawn.
 * @param {RunAgentStreamOptions} options
 * @returns {Promise<AgentRunResult>}
 */
export function runAgentStream({ agent, content, onChunk, onStatus, signal }) {
  return runTurn(agent, content, { onChunk, onStatus, signal });
}

/**
 * Cheaply verifies a provider's binary itself actually resolves and runs —
 * spawns its versionCommand (`claude --version` for Claude), no model call,
 * no cwd/session involved, so it costs no tokens and takes milliseconds.
 * Used before persisting an agent to catch a broken/missing binary, e.g. a
 * bad CLAUDE_BIN (the other half of what broke agent creation last time,
 * alongside a missing workingDir, which is checked separately via
 * existsSync). Deliberately does NOT verify resumeId — an invalid resume
 * id is the user's call and surfaces at message-send time instead of
 * blocking creation with a real, costly round-trip.
 *
 * @param {import('./providers/index.js').AgentProvider} [provider]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function verifyProviderAvailable(provider = getProvider()) {
  const { command, args } = provider.versionCommand();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      resolve({ ok: false, error: t('errors.agentSpawnFailed', { provider: provider.displayName, message: err.message }) });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || t('errors.agentExitCode', { provider: provider.displayName, code }) });
        return;
      }
      resolve({ ok: true });
    });
  });
}
