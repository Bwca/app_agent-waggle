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
import { providerEnv } from './agentEnv.js';
import { t } from '../i18n/t.js';

/**
 * The flattened value a permission card shows for a denial, and sends back
 * as GRANT_PERMISSION's `value`: a file path, a command, else the input as
 * JSON.
 * @param {PermissionDenial} denial
 * @returns {string}
 */
function denialValue(denial) {
  return String(denial.tool_input?.file_path ?? denial.tool_input?.command ?? JSON.stringify(denial.tool_input));
}

/**
 * Attaches to each denial what clicking Grant on it would save
 * (AgentProvider.grantFor), so the permission card can say so before the
 * click. Reported live: Grant on one `python3 -c` print had silently saved
 * a rule covering every Python program, with nothing on the card to show it.
 * @param {PermissionDenial[]} denials
 * @param {import('./providers/index.js').AgentProvider} [provider]
 * @returns {(PermissionDenial & { grant: import('./providers/index.js').PermissionGrant })[]}
 */
export function withGrantPreviews(denials, provider = getProvider()) {
  return denials.map((denial) => ({ ...denial, grant: provider.grantFor(denial.tool_name, denialValue(denial)) }));
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
 *
 * Which tools have patterns worth comparing, and what they are, is the
 * provider's call (AgentProvider.overlappingPatterns) — this only knows
 * that a denial whose patterns are all already covered adds nothing.
 * @param {PermissionDenial[]} denials
 * @param {import('./providers/index.js').AgentProvider} [provider] - The
 *   provider of the agent these denials came from.
 * @returns {PermissionDenial[]}
 */
export function dedupePermissionDenials(denials, provider = getProvider()) {
  const kept = [];
  const seenExact = new Set();
  const coveredPatterns = new Set();

  for (const denial of denials) {
    const value = denialValue(denial);
    const exactKey = `${denial.tool_name}::${value}`;
    if (seenExact.has(exactKey)) continue;

    const patterns = provider.overlappingPatterns(denial.tool_name, value);
    if (patterns) {
      if (patterns.length && patterns.every((p) => coveredPatterns.has(p))) continue;
      for (const p of patterns) coveredPatterns.add(p);
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
 *   providers/claude.js's createTurnAccumulator and
 *   db.js's Message.isLocalCommandOnly for why callers need this.
 * @property {boolean} contextCleared - True if this turn was a bare
 *   "/clear" the CLI's own local-command dispatcher intercepted — a
 *   DIFFERENT wire shape than wasLocalCommand above (no synthetic assistant
 *   message; a "system"/"conversation_reset" event instead), and one that
 *   genuinely rotates `sessionId` to a brand-new CLI session rather than
 *   just intercepting a turn within the existing one. See
 *   providers/claude.js's createTurnAccumulator and
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
 *   providers/claude.js's createTurnAccumulator. Usually empty.
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
 * @property {import('./agentProcessManager.js').TurnContent} content - Full
 *   message content, including conversation context, or a function that
 *   builds it once the turn actually starts
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
 * @param {{ workingDir?: string }} [agent] - The agent-to-be, for a provider
 *   that resolves its binary per project (see AgentProvider.versionCommand).
 * @returns {Promise<{ ok: true, version: string, source: import('./providers/index.js').BinarySource } | { ok: false, error: string, source: import('./providers/index.js').BinarySource }>}
 *   `version` is the binary's own first line of --version output.
 */
export async function verifyProviderAvailable(provider = getProvider(), agent = undefined) {
  const { command, args, source } = provider.versionCommand(agent);
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: providerEnv(provider), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      resolve({ ok: false, source, error: t('errors.agentSpawnFailed', { provider: provider.displayName, message: err.message }) });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, source, error: stderr.trim() || t('errors.agentExitCode', { provider: provider.displayName, code }) });
        return;
      }
      resolve({ ok: true, source, version: stdout.trim().split('\n')[0] ?? '' });
    });
  });
}

/** How long a provider gets to list its models before the picker gives up on it. */
const LIST_MODELS_TIMEOUT_MS = 20_000;

/**
 * Lists the model IDs a provider can run, via its modelsCommand, in the
 * agent-to-be's working directory (a project can configure its own
 * models). No model call. For the model picker only: a model typed by hand
 * is still accepted, so a failure here just means no list to pick from.
 *
 * @param {import('./providers/index.js').AgentProvider} provider
 * @param {{ workingDir?: string }} [agent]
 * @returns {Promise<{ ok: true, models: string[] } | { ok: false, error: string }>}
 *   `ok: false` too for a provider with no modelsCommand.
 */
export async function listProviderModels(provider, agent = undefined) {
  if (!provider.modelsCommand) return { ok: false, error: `${provider.displayName} has no model list` };
  const { command, args } = provider.modelsCommand(agent);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: agent?.workingDir,
      env: providerEnv(provider),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: LIST_MODELS_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
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
      resolve({ ok: true, models: parseModelList(stdout) });
    });
  });
}

/**
 * One model ID per line; anything with whitespace in it is a stray message,
 * not an ID.
 * @param {string} stdout
 * @returns {string[]} Deduplicated, in the CLI's own order.
 */
export function parseModelList(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line && !/\s/.test(line));
  return [...new Set(lines)];
}
