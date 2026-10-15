/**
 * @fileoverview Owns one persistent `claude` CLI process per agent, kept
 * alive for as long as the agent is in a chat, instead of spawning a fresh
 * one-shot process per turn (the old model in agentRunner.js). This is what
 * lets MCP servers — and anything else expensive to establish — survive
 * across turns instead of being torn down and re-connected on every single
 * message.
 *
 * Confirmed empirically (real `claude` CLI, not assumed): a single
 * `--print --input-format=stream-json --output-format=stream-json` process
 * genuinely handles multiple sequential turns without closing stdin,
 * remembering context with no `--resume` needed between turns of the same
 * live process. Interrupting a turn (SIGINT) still ends the process
 * afterward regardless — handled here as "evict and let the next turn
 * respawn + --resume", the same recovery path already used for a crash.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { basename } from 'path';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'agentProcessManager' });

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Kills a process, including any children it spawned (an MCP server
 * subprocess, say) — not just the process itself.
 *
 * Windows has no real equivalent of POSIX signals: Node's child.kill()
 * there ignores what the signal actually means and always calls the OS's
 * TerminateProcess() — an unconditional, immediate kill with zero chance
 * for the target to run its own cleanup (confirmed against Node's own
 * docs and multiple nodejs/node issues, e.g. #12378, #22761). On POSIX,
 * `claude` gets a real SIGTERM/SIGINT and tears down its own spawned MCP
 * subprocesses as part of its normal signal handling (confirmed
 * empirically this session). On Windows, that graceful teardown can never
 * happen — the process is just gone. If it had spawned a local MCP
 * server as a child of its own, that child can be orphaned, left holding
 * a port/lock/session state that the NEXT `claude` process (spawned on
 * the next turn, or after a restart) then can't cleanly take over —
 * surfacing as "MCP not connected" with no obvious cause.
 *
 * `taskkill /T /F` doesn't make Windows shutdown graceful (nothing can),
 * but it does kill the whole process tree together rather than leaving
 * grandchildren behind, which is the actual failure mode above.
 * @param {import('child_process').ChildProcess} child
 * @param {string} signal
 * @param {string} agentId - Logged for context, so a platform-specific
 *   issue like the one this function exists for is traceable per-agent.
 * @returns {void}
 */
function killTree(child, signal, agentId) {
  if (process.platform === 'win32') {
    log.debug({ agentId, pid: child.pid }, 'killing process tree via taskkill (win32)');
    // Best-effort: if the process already exited on its own, taskkill
    // just reports "not found" on stderr — nothing to react to either way,
    // since the caller only cares about the tracked child's own 'exit' event.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('error', () => {});
  } else {
    log.debug({ agentId, pid: child.pid, signal }, 'killing process via signal (posix)');
    child.kill(signal);
  }
}

/**
 * @typedef {Object} ManagedProcess
 * @property {import('child_process').ChildProcess} child
 * @property {string} agentId
 * @property {string} buffer - Partial last line of stdout not yet parsed
 * @property {number} costSoFar - The CLI's running `total_cost_usd` as of
 *   the last `result` event this process reported — see withPerTurnCost.
 * @property {{ handleEvent: (event: object) => void, handleExit: (code: number|null, sig: string|null) => void } | null} currentTurn
 * @property {TurnAccumulator | null} background - Accumulates events that
 *   arrive while `currentTurn` is null — see handleUnsolicitedEvent.
 * @property {BackgroundStream | null} [backgroundStream] - The live stream
 *   the caller opened (see onBackgroundStream) for the unsolicited turn
 *   `background` is currently accumulating, if any.
 * @property {BackgroundTask[]} [backgroundTasks] - The CLI's own most
 *   recently reported list of still-running background tasks — see
 *   onBackgroundTasksChanged.
 * @property {Promise<void>} queue - Chain of pending/running turns, so two
 *   turns never write to this process's stdin concurrently.
 * @property {string[]} skills - The CLI's own `skills` list from its most
 *   recent `system/init` event — the built-in/marketplace/plugin skills
 *   this specific process can actually invoke via "/name" (a superset of
 *   `slash_commands` narrowed to just the invokable ones; excludes
 *   interactive-only built-ins like /clear or /model). Seeded from
 *   `lastKnownSkills` at spawn time (see its docs), not always empty even
 *   for a brand-new process instance — only genuinely empty for an agent
 *   whose process has never once reported in.
 */

/** @type {Map<string, ManagedProcess>} */
const processes = new Map();

/**
 * An agent's most recently reported skill list, kept even after its process
 * exits — reported live: a fresh respawn (server restart aside, this is the
 * common case: any permission grant or workingDir/YOLO/resumeId change kills
 * and respawns the process) starts with an empty `skills` array until that
 * NEW process's own `system/init` event arrives, but parseSkillInvocation's
 * validity check runs synchronously the moment a message comes in — for a
 * message sent immediately after a respawn (very plausible right after a
 * grant unblocks a queued follow-up), that race means a genuine builtin
 * skill invocation incorrectly falls through to plain-chat routing instead
 * of the intended bare-command CLI dispatch. Skills are a property of the
 * CLI installation/config, not of any one process instance, so seeding a
 * fresh process's `skills` from here (rather than starting empty) is safe:
 * still corrected by that process's own init event moments later if the
 * config genuinely changed underneath it (a plugin installed/removed
 * between respawns, say).
 * @type {Map<string, string[]>}
 */
const lastKnownSkills = new Map();

/**
 * Handlers registered via onBackgroundTurn, one per agent. See that
 * function's docs for what fires them.
 * @type {Map<string, (turn: { text: string, toolCalls: ToolCall[], sessionId: string | null, permissionDenials: import('./agentRunner.js').PermissionDenial[] }) => void>}
 */
const backgroundTurnHandlers = new Map();

/**
 * Handlers registered via onBackgroundCompaction, one per agent. See that
 * function's docs for what fires them.
 * @type {Map<string, (compaction: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }) => void>}
 */
const backgroundCompactionHandlers = new Map();

/**
 * Handlers registered via onBackgroundError, one per agent. See that
 * function's docs for what fires them.
 * @type {Map<string, (error: { errorMessage: string, streamId: string | null }) => void>}
 */
const backgroundErrorHandlers = new Map();

/**
 * @typedef {Object} BackgroundUsage
 * @property {TurnUsage | null} usage
 * @property {number | null} contextTokens
 * @property {number | null} totalCostUsd - This turn's own cost (see
 *   withPerTurnCost).
 * @property {number | null} durationMs
 * @property {boolean} isError
 */

/**
 * Handlers registered via onBackgroundUsage, one per agent. See that
 * function's docs for what fires them.
 * @type {Map<string, (usage: BackgroundUsage) => void>}
 */
const backgroundUsageHandlers = new Map();

/**
 * @typedef {Object} BackgroundTask
 * @property {string} id - The CLI's own task_id
 * @property {string} type - e.g. "local_bash"
 * @property {string} description - The CLI's own human-readable label
 */

/**
 * @typedef {Object} BackgroundStream
 * @property {string} streamId
 * @property {(text: string) => void} onChunk
 * @property {(status: string) => void} onStatus
 * @property {() => void} discard - Called when the unsolicited turn ends
 *   without anything to hand to onBackgroundTurn/onBackgroundError (no
 *   content, or the process died mid-turn), so the caller can tear down
 *   whatever live UI it opened for it.
 */

/**
 * Handlers registered via onBackgroundStream, one per agent.
 * @type {Map<string, () => BackgroundStream | null>}
 */
const backgroundStreamHandlers = new Map();

/**
 * Handlers registered via onBackgroundTasksChanged, one per agent.
 * @type {Map<string, (tasks: BackgroundTask[]) => void>}
 */
const backgroundTasksHandlers = new Map();

/**
 * Context size, in the CLI's own `--autocompact` syntax, at which an agent's
 * session gets summarized. Overridable via APP_AUTOCOMPACT (the CLI accepts
 * 'auto', or 100k–1M, e.g. "300k" or "300000").
 *
 * Deliberately not 'auto': observed live, 'auto' only compacts near the
 * model's full window (one agent compacted at 967,457 → 11,406 tokens), so
 * sessions sat at 400k–800k between compactions. Every request in a turn
 * re-reads that whole context, and a turn that resumes after the prompt
 * cache expired re-writes all of it first. Four such agents nudged at once
 * used up a freshly-reset session limit before any of them finished a
 * reply. A smaller window keeps each request cheap at the cost of
 * summarizing more often.
 */
const AUTOCOMPACT_WINDOW = process.env.APP_AUTOCOMPACT || '200k';

/**
 * @param {ManagedProcess} proc
 * @returns {boolean}
 */
function isAlive(proc) {
  return proc.child.exitCode === null && proc.child.signalCode === null;
}

/**
 * Turns a `result` event's `total_cost_usd` into the cost of just that turn.
 * Confirmed against the real CLI: in a persistent stream-json process it's a
 * running total for the whole process (three one-line turns reported
 * 0.0018, 0.0035, 0.0041), while `usage` alongside it is per-turn. Treating
 * the running total as one turn's cost made "last turn" show the process
 * total, and added the whole total to cumulativeCostUsd again on every turn,
 * including errored turns that spent nothing. Reported live: an agent showing
 * $259 all-time. Every result event goes through this, foreground or
 * unsolicited, so the baseline stays in step with the CLI's own total.
 * Returns the event unchanged if it isn't a costed `result` event.
 * @param {{ costSoFar: number }} proc - Mutated: costSoFar advances to the
 *   event's running total.
 * @param {object} event
 * @returns {object}
 */
export function withPerTurnCost(proc, event) {
  if (event.type !== 'result' || typeof event.total_cost_usd !== 'number') return event;
  const turnCost = Math.max(0, event.total_cost_usd - proc.costSoFar);
  proc.costSoFar = Math.max(proc.costSoFar, event.total_cost_usd);
  return { ...event, total_cost_usd: turnCost };
}

/**
 * Builds the same CLI args agentRunner.js's runAgentStream always built —
 * see its (now-delegating) docs for the reasoning behind each flag.
 * @param {import('../store/db.js').Agent} agent
 * @returns {string[]}
 */
function buildArgs(agent) {
  const args = [
    '--print',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
    // Lets the CLI summarize its own older context once a resumed session's
    // cache grows past AUTOCOMPACT_WINDOW, instead of every request paying
    // to re-read a huge history in full. Lossy-but-graceful, unlike dropping
    // resumeId outright (which forgets everything).
    '--autocompact', AUTOCOMPACT_WINDOW,
  ];
  if (agent.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  args.push('--add-dir', agent.workingDir);
  for (const p of agent.extraAllowedPaths ?? []) {
    args.push('--add-dir', p);
  }
  if (agent.allowedToolPatterns?.length && !agent.dangerouslySkipPermissions) {
    args.push('--allowedTools', agent.allowedToolPatterns.join(' '));
  }
  if (agent.resumeId) {
    args.push(`--resume=${agent.resumeId}`);
  }
  if (agent.chromeAccess) {
    args.push('--chrome');
  }
  // Confirmed empirically (real CLI, not assumed): pairing --model with
  // --resume on an existing session genuinely switches which model handles
  // the NEXT turn, without losing conversation context — same session_id,
  // same history. The CLI does report a cache_miss_reason: "model_changed"
  // diagnostic on that turn (prompt caching is model-specific, so a switch
  // costs one full cache rebuild), but it's a real mid-conversation switch,
  // not a fresh session. See modelOverride's docs in store/db.js.
  if (agent.modelOverride) {
    args.push('--model', agent.modelOverride);
  }
  return args;
}

/**
 * Parses a single newline-delimited JSON line from claude CLI stream-json output.
 * @param {string} line
 * @returns {{ type: string, [key: string]: unknown } | null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Recognizes the CLI's own "MCP OAuth session expired" wording. Confirmed
 * (by inspecting the installed `claude` binary directly) that this text is
 * literally embedded in the CLI itself — but it surfaces to us as ordinary
 * assistant text (the model just relays what the failed tool call told it),
 * not as a distinct stream-json event type we could otherwise key off of.
 *
 * Why this matters: MCP server auth is read fresh only once, at this
 * process's own spawn time (see spawnProcess docs) — it is NEVER re-read
 * for the life of the process. If a user re-authenticates externally
 * (`claude` → `/login` in a real terminal) while this agent's persistent
 * process is still running, that process has no way to notice — it keeps
 * using the stale token it started with, indefinitely, until killed and
 * respawned. Matching on wording is inherently version-fragile, so this
 * stays a narrow, best-effort net rather than the sole safeguard: it lets
 * the *next* turn spawn a fresh process that re-reads current auth from
 * disk, instead of a process wedged on the credentials it saw at spawn.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMcpAuthFailure(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('oauth session expired')
    || (lower.includes('failed to authenticate') && lower.includes('could not be'));
}

/**
 * @typedef {Object} ToolCall
 * @property {string} id - The tool_use content block's own id — links it to
 *   its eventual tool_result.
 * @property {string} name - Raw tool name, e.g. "Bash", "Edit", or an MCP
 *   tool's full name like "mcp__linear__list_issues".
 * @property {string} label - Human "what's happening" summary (see
 *   describeToolUse) — the same text already streamed live as
 *   AGENT_STREAM_STATUS, kept here so it's still visible after the fact.
 * @property {string} result - The tool's own output (stdout, file diff,
 *   MCP response, ...), capped via truncateToolResult — empty string if no
 *   matching tool_result ever arrived (e.g. the call was permission-denied).
 * @property {boolean} isError - True if the tool_result reported is_error.
 */

/** Caps a single tool result's stored/displayed size — this is chat
 * transcript chrome, not a log viewer; a multi-megabyte `cat` dump has no
 * business being shipped to the client and persisted in SQLite in full. */
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Flattens a tool_result event's `content` (a bare string, OR an array of
 * Anthropic content blocks — text/image/etc., same shape as any other
 * message content) down to one display string.
 * @param {unknown} content
 * @returns {string}
 */
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === 'text' ? block.text : `[${block?.type ?? 'unknown'}]`))
      .join('\n');
  }
  return '';
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateToolResult(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`;
}

/**
 * Turns a tool_use content block into a short, human "what's happening now"
 * label — mirrors the live activity Claude Code itself shows in a terminal.
 * Falls back to the raw tool name for anything unrecognized (custom skills,
 * MCP tools, future built-ins), since the tool set isn't fixed.
 * @param {{ name: string, input?: Record<string, unknown> }} block
 * @returns {string}
 */
function describeToolUse({ name, input }) {
  const baseName = (p) => (typeof p === 'string' && p ? basename(p) : '');
  switch (name) {
    case 'Bash':
      return `Running: ${input?.description || input?.command || '…'}`;
    case 'Read':
      return `Reading ${baseName(input?.file_path) || 'a file'}`;
    case 'Write':
      return `Writing ${baseName(input?.file_path) || 'a file'}`;
    case 'Edit':
    case 'NotebookEdit':
      return `Editing ${baseName(input?.file_path ?? input?.notebook_path) || 'a file'}`;
    case 'Grep':
      return `Searching for "${input?.pattern ?? ''}"`;
    case 'Glob':
      return `Finding files matching "${input?.pattern ?? ''}"`;
    case 'WebFetch':
      return `Fetching ${input?.url ?? 'a page'}`;
    case 'WebSearch':
      return `Searching the web for "${input?.query ?? ''}"`;
    case 'Task':
      return `Delegating: ${input?.description ?? 'a subtask'}`;
    default:
      return `Using ${name}`;
  }
}

/**
 * @typedef {Object} TurnUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheReadInputTokens
 */

/**
 * @typedef {Object} TurnAccumulator
 * @property {string} fullText
 * @property {string} resultText
 * @property {string | null} sessionId
 * @property {import('./agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {Map<string, ToolCall>} toolCalls
 * @property {boolean} done - Set once a `result` event has been fed in.
 * @property {boolean} wasLocalCommand - True if this turn's `assistant`
 *   event was the CLI's synthetic local-command reply, not a real model
 *   turn — see handleEvent's docs.
 * @property {string | null} errorMessage - Set once a `result` event with
 *   `is_error: true` has been fed in — see handleEvent's docs. Null for a
 *   normal, successful turn.
 * @property {TurnUsage | null} usage - Token accounting from the `result`
 *   event's own `usage` block. Set even when the turn ends in error (e.g. a
 *   session-limit failure still reports what was actually spent before it
 *   hit the wall) — null only when no `result` event ever arrived at all
 *   (a process crash mid-turn). This is what onward logging (ws/handler.js's
 *   'turn ended'/'turn errored') uses to make token burn per agent/turn
 *   debuggable after the fact, instead of having to guess from timestamps.
 * @property {number | null} contextTokens - input + cache-creation +
 *   cache-read tokens of this turn's LAST model request, from that
 *   `assistant` event's own `message.usage` — i.e. how big the session's
 *   context actually is now. Not derivable from `usage` above: the `result`
 *   event's totals are summed across every request in the turn (one per
 *   tool-call step, each re-reading the whole context), so a 20-step turn
 *   on a 1M context reports ~20M. Null for a turn with no real assistant
 *   event (a pure local command, or an error before any request).
 * @property {number | null} totalCostUsd - The CLI's own cost estimate for
 *   this turn alone, same caveats as `usage` — the process-wide running
 *   total the CLI reports is already converted by withPerTurnCost before
 *   the event gets here.
 * @property {number | null} durationMs - Wall-clock turn duration per the
 *   CLI's own `result` event.
 * @property {string | null} model - The real model ID reported on this
 *   turn's `assistant` events (e.g. "claude-sonnet-5"), straight from the
 *   CLI — this app never requests a specific model itself (no `--model`
 *   spawn flag), so this is purely what the CLI resolved on its own. Null
 *   for a turn that never produced a real assistant event (a pure local
 *   command, or a crash before any output) — see wasLocalCommand's docs
 *   for why "<synthetic>" is excluded here rather than captured as-is.
 * @property {{ trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[]} compactions -
 *   Every `system`/`compact_boundary` event this turn reported (confirmed
 *   directly against the installed CLI binary's stream-json schema) —
 *   almost always 0 or 1, an array only in case the CLI ever reports more
 *   than one in a single turn. Usually empty; see buildArgs' `--autocompact`
 *   for what triggers this.
 * @property {(event: object) => void} handleEvent
 */

/**
 * The text/tool_use/tool_result/result parsing at the heart of a turn —
 * shared by runOneTurn (an explicitly-initiated turn, streamed live via
 * onChunk/onStatus) and handleUnsolicitedEvent (a turn the CLI resumes and
 * runs entirely on its own — see that function's docs). Previously this
 * logic lived only inline in runOneTurn; factored out so both call sites
 * parse the exact same event shapes instead of two copies drifting apart.
 * @param {{ onChunk?: (text: string) => void, onStatus?: (status: string) => void }} [callbacks]
 * @returns {TurnAccumulator}
 */
export function createTurnAccumulator({ onChunk, onStatus } = {}) {
  // Tracks how much of each text block (keyed by its index in the current
  // assistant message's content array) has already been emitted, so a
  // streaming delta can be computed per-block rather than against a single
  // turn-wide length — see the message-id check below for why that matters.
  let lastAssistantMessageId;
  let textBlockSeenLengths = new Map();

  /** @type {TurnAccumulator} */
  const turn = {
    fullText: '',
    resultText: '',
    sessionId: null,
    permissionDenials: [],
    toolCalls: new Map(),
    done: false,
    wasLocalCommand: false,
    contextCleared: false,
    errorMessage: null,
    usage: null,
    contextTokens: null,
    totalCostUsd: null,
    durationMs: null,
    model: null,
    compactions: [],
    handleEvent(event) {
      if (typeof event.session_id === 'string') turn.sessionId = event.session_id;

      // The `claude` CLI's OWN local-command dispatcher (its built-in
      // commands like "/chrome", "/help" — a different, larger set than
      // this project's .claude/commands/*.md skills) intercepts a bare
      // "/word" turn and answers it locally, entirely client-side, BEFORE
      // any of the turn's actual content (including a first-ever-turn
      // [System] preamble sent alongside it — see buildPromptBlocks in
      // ws/handler.js) ever reaches the model. Confirmed two different ways
      // this actually surfaces: the on-disk session transcript records a
      // {"type":"system","subtype":"local_command"} pair, but the LIVE
      // --output-format=stream-json wire protocol this function actually
      // parses is a DIFFERENT shape — a synthetic `assistant` event with
      // message.model === "<synthetic>" (and the paired `result` event has
      // num_turns: 0, total_cost_usd: 0 — zero real API usage). Checked
      // directly against a raw `claude --print --output-format=stream-json`
      // run, not assumed. Flagged here so the caller can avoid treating
      // this turn as the agent having genuinely "spoken" — see
      // Message.isLocalCommandOnly.
      if (event.type === 'assistant' && event.message?.model === '<synthetic>') turn.wasLocalCommand = true;
      else if (event.type === 'assistant' && typeof event.message?.model === 'string') turn.model = event.message.model;

      if (event.type === 'assistant' && event.message?.model !== '<synthetic>' && event.message?.usage) {
        const u = event.message.usage;
        turn.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      }

      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        // Confirmed live against the real CLI: a turn with "text, tool call,
        // more text" isn't one assistant message whose content array keeps
        // growing across the tool call — it's a SEQUENCE OF SEPARATE
        // assistant messages, a new message.id each time a tool call
        // interrupts the model's output, each with its own content array
        // that starts fresh. Comparing a new message's (short, just-started)
        // text against the PREVIOUS message's already-longer length silently
        // dropped or mangled every text block after the turn's first tool
        // call — so block text is tracked per (message id, block index)
        // instead of against a single turn-wide length.
        if (event.message.id !== lastAssistantMessageId) {
          lastAssistantMessageId = event.message.id;
          textBlockSeenLengths = new Map();
        }
        event.message.content.forEach((block, index) => {
          if (block.type === 'text') {
            const seenLength = textBlockSeenLengths.get(index) ?? 0;
            const delta = block.text.slice(seenLength);
            if (delta) {
              textBlockSeenLengths.set(index, block.text.length);
              turn.fullText += delta;
              onChunk?.(delta);
            }
          } else if (block.type === 'tool_use') {
            const label = describeToolUse(block);
            onStatus?.(label);
            turn.toolCalls.set(block.id, { id: block.id, name: block.name, label, result: '', isError: false });
          }
        });
      } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
        // Tool results are fed back to the model as a "user" turn (same
        // wire shape the Anthropic API always uses) — this is where the
        // actual output of a tool_use above shows up, matched by id.
        for (const block of event.message.content) {
          if (block.type !== 'tool_result') continue;
          const call = turn.toolCalls.get(block.tool_use_id);
          if (!call) continue;
          call.result = truncateToolResult(extractToolResultText(block.content));
          call.isError = !!block.is_error;
        }
      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        // The CLI's own --autocompact stepping in mid-turn (or a manual
        // /compact): confirmed directly against the installed binary's
        // stream-json schema — {"type":"system","subtype":"compact_boundary",
        // "compact_metadata":{trigger,pre_tokens,post_tokens,...}}. Not
        // otherwise visible anywhere (see agentProcessManager.js's buildArgs
        // --autocompact docs) — surfaced here so ws/handler.js can post a
        // system note into the chat instead of it silently passing.
        const meta = event.compact_metadata;
        if (meta) {
          turn.compactions.push({
            trigger: meta.trigger ?? 'auto',
            preTokens: meta.pre_tokens ?? null,
            postTokens: meta.post_tokens ?? null,
          });
        }
      } else if (event.type === 'system' && event.subtype === 'conversation_reset') {
        // A bare "/clear" — confirmed directly against the installed CLI
        // binary via a raw two-turn stream-json run, NOT the same shape as
        // "/chrome"/"/help" above (no synthetic assistant message at all).
        // Instead this fires alone, still tagged with the OLD session_id,
        // and is immediately followed by a fresh system/init carrying a
        // BRAND-NEW session_id — i.e. unlike /compact, this genuinely
        // rotates which CLI session this process is resuming. turn.sessionId
        // (set generically above from every event) ends up holding that new
        // id by the time this turn's own `result` event arrives, which is
        // what callers need to persist going forward — see
        // store/db.js's recordContextClear.
        turn.contextCleared = true;
      } else if (event.type === 'result') {
        turn.resultText = typeof event.result === 'string' ? event.result : turn.fullText;
        if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
          turn.permissionDenials = event.permission_denials;
        }
        if (event.usage) {
          turn.usage = {
            inputTokens: event.usage.input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
            cacheCreationInputTokens: event.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: event.usage.cache_read_input_tokens ?? 0,
          };
        }
        if (typeof event.total_cost_usd === 'number') turn.totalCostUsd = event.total_cost_usd;
        if (typeof event.duration_ms === 'number') turn.durationMs = event.duration_ms;
        // A `result` event isn't always a successful completion — confirmed
        // live: an unusable CLI flag (e.g. an agent created with a bogus
        // resumeId, so --resume is invalid) still produces a well-formed
        // `result` event, just with is_error:true, subtype
        // "error_during_execution", and the actual message in `errors`
        // rather than `result` (which is why the fallback above lands on
        // turn.fullText — empty, since the model never ran). Without this
        // check, that error event was previously treated exactly like a
        // real empty-text success: the turn "completed" with fullText: '',
        // silently — an empty reply bubble with zero diagnostic, and every
        // later message to that agent failing the exact same silent way.
        if (event.is_error) {
          turn.errorMessage = Array.isArray(event.errors) && event.errors.length
            ? event.errors.join('; ')
            : (turn.resultText || 'unknown error');
        }
        turn.done = true;
      }
    },
  };
  return turn;
}

/**
 * Registers the handler to call whenever this agent's persistent process
 * produces a full turn's worth of output WITHOUT Clauhort having written a
 * new turn to its stdin — i.e. the CLI's own background-task-completion
 * feature resuming and reporting on its own initiative.
 *
 * Confirmed empirically against the real CLI (v2.1.223), not assumed: give
 * an agent "run `sleep 8 && echo done` in the background, tell me you'll
 * let me know once it's done, then end your turn" against a persistent
 * process (stdin kept open, exactly this module's architecture). The first
 * turn resolves normally on its own `result` event, text "I'll let you
 * know...". ~8 seconds later, with NOTHING written to stdin in between, the
 * SAME process unprompted emits: system/background_tasks_changed,
 * system/task_updated, system/task_notification (status: "completed"),
 * then a fresh system/init, a new assistant text event ("The background
 * command finished..."), and its own new result event. Before this
 * function existed, those later events arrived while `proc.currentTurn`
 * was already null (the original turn had long since resolved and cleared
 * it) and were silently dropped on the floor by `proc.currentTurn?.
 * handleEvent(event)` — the agent's promised follow-up never reached the
 * chat, which is the exact bug this module exists to fix. See
 * handleUnsolicitedEvent for where events actually get routed here.
 *
 * One handler per agent; registering again replaces the previous one
 * (ws/handler.js re-registers on every turn it runs — cheap, and keeps
 * this agnostic of exactly when in an agent's lifecycle its process first
 * comes alive).
 * @param {string} agentId
 * @param {(turn: { streamId: string | null, text: string, toolCalls: ToolCall[], sessionId: string | null, permissionDenials: import('./agentRunner.js').PermissionDenial[], model: string | null }) => void} handler
 * @returns {void}
 */
export function onBackgroundTurn(agentId, handler) {
  backgroundTurnHandlers.set(agentId, handler);
}

/**
 * Registers the handler to call whenever this agent's persistent process
 * reports a `compact_boundary` OUTSIDE of an explicit turn — i.e.
 * --autocompact firing (or a background task's own resumed turn triggering
 * one) while `proc.currentTurn` is null. A compaction during an explicit
 * turn is already captured on that turn's own `compactions` array and
 * surfaced by the caller once the turn resolves; this covers the gap where
 * one happens while the agent is otherwise idle, which handleUnsolicitedEvent
 * would silently drop since it isn't part of any assistant/tool-result
 * stretch of output and may never be followed by one.
 *
 * One handler per agent; same replace-on-reregister contract as
 * onBackgroundTurn.
 * @param {string} agentId
 * @param {(compaction: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }) => void} handler
 * @returns {void}
 */
export function onBackgroundCompaction(agentId, handler) {
  backgroundCompactionHandlers.set(agentId, handler);
}

/**
 * Registers the handler to call whenever this agent's persistent process
 * resumes a backgrounded turn ENTIRELY ON ITS OWN and that turn ends in a
 * `result` with is_error:true (e.g. the account-wide session limit named in
 * maybeScheduleAutoContinue's docs, ws/handler.js, still hadn't cleared when
 * the CLI's own background-task machinery retried it) rather than reporting
 * normal content — see handleUnsolicitedEvent's `turn.errorMessage` check.
 * Reported live: an agent running its own ~20-minute self-rescheduled
 * check-in loop kept hitting the same still-active session limit on every
 * retry, and before this handler existed each failed retry fell through to
 * onBackgroundTurn's handler anyway (nothing distinguished it from a real
 * reply), posting the bare "You've hit your session limit · resets ..."
 * text into the chat as if the agent had genuinely said it — over and over,
 * once per retry, for hours, with no relation to chat.autoContinue and no
 * scheduled message for the user to see or cancel. The foreground
 * equivalent (runOneTurn) has always had this same is_error guard; this is
 * that guard's missing half for the background path.
 *
 * One handler per agent; same replace-on-reregister contract as
 * onBackgroundTurn.
 * @param {string} agentId
 * @param {(error: { errorMessage: string, streamId: string | null }) => void} handler
 * @returns {void}
 */
export function onBackgroundError(agentId, handler) {
  backgroundErrorHandlers.set(agentId, handler);
}

/**
 * Registers the handler to call with the token/cost accounting of every
 * turn this agent's process ran ENTIRELY ON ITS OWN (see onBackgroundTurn),
 * whatever its outcome: a real reply, an error (onBackgroundError), or
 * nothing worth posting. Kept separate from those handlers because the
 * spend is real in all three cases, including the one that reaches neither.
 * Before this existed, a self-resumed turn's spend was never recorded, so
 * an agent running long background work looked far cheaper than it was.
 *
 * One handler per agent; same replace-on-reregister contract as
 * onBackgroundTurn.
 * @param {string} agentId
 * @param {(usage: BackgroundUsage) => void} handler
 * @returns {void}
 */
export function onBackgroundUsage(agentId, handler) {
  backgroundUsageHandlers.set(agentId, handler);
}

/**
 * Registers the factory called the moment an unsolicited turn (see
 * onBackgroundTurn) STARTS, rather than only once it ends — returns a
 * BackgroundStream whose onChunk/onStatus get the same live text/tool-call
 * feed an explicit turn's callbacks do. Reported live: a background task
 * finishing could kick off a self-resumed turn running 50+ tool calls over
 * many minutes, all completely invisible until its final `result` landed,
 * so the agent looked idle (or hung) the whole time. The returned streamId
 * is passed back on the matching onBackgroundTurn/onBackgroundError call so
 * the caller can close the stream it opened; the factory may return null
 * (e.g. agent no longer in a chat) to skip streaming entirely.
 *
 * One handler per agent; same replace-on-reregister contract as
 * onBackgroundTurn.
 * @param {string} agentId
 * @param {() => BackgroundStream | null} factory
 * @returns {void}
 */
export function onBackgroundStream(agentId, factory) {
  backgroundStreamHandlers.set(agentId, factory);
}

/**
 * Registers the handler called whenever an agent's set of still-running
 * background tasks changes — confirmed directly against the installed CLI:
 * it emits {"type":"system","subtype":"background_tasks_changed","tasks":
 * [{task_id,task_type,description,...}]} carrying the COMPLETE current list
 * (not a delta) both when a task starts and when it finishes (an empty
 * list), whether or not a turn is in flight at the time. Without surfacing
 * this, an agent that ends its turn with "I'll wait for that to finish"
 * looked exactly like one that was done — nothing indicated it was still
 * waiting on anything. Also fired with [] when the process exits with tasks
 * outstanding, since they die with it.
 * @param {string} agentId
 * @param {(tasks: BackgroundTask[]) => void} handler
 * @returns {void}
 */
export function onBackgroundTasksChanged(agentId, handler) {
  backgroundTasksHandlers.set(agentId, handler);
}

/**
 * Every live agent's non-empty background task list — for catching a
 * freshly-connected client up (see ws/handler.js's handleConnection).
 * @returns {Array<{ agentId: string, tasks: BackgroundTask[] }>}
 */
export function getAllBackgroundTasks() {
  return [...processes.values()]
    .filter((proc) => proc.backgroundTasks?.length)
    .map((proc) => ({ agentId: proc.agentId, tasks: proc.backgroundTasks }));
}

/**
 * Applies a `system/background_tasks_changed` event to a process — see
 * onBackgroundTasksChanged. Exported for its unit test.
 * @param {ManagedProcess} proc
 * @param {{ tasks?: unknown }} event
 * @returns {void}
 */
export function applyBackgroundTasksChanged(proc, event) {
  const tasks = Array.isArray(event.tasks)
    ? event.tasks.map((task) => ({
        id: String(task.task_id ?? ''),
        type: String(task.task_type ?? ''),
        description: String(task.description ?? ''),
      }))
    : [];
  proc.backgroundTasks = tasks;
  backgroundTasksHandlers.get(proc.agentId)?.(tasks);
}

/**
 * The built-in/marketplace/plugin skill names an agent can invoke: its live
 * process's own most recent report if one is currently running, falling
 * back to `lastKnownSkills` (see its docs) when there's no live process at
 * all right now — e.g. the old one just died and the next turn hasn't
 * spawned its replacement yet, which happens synchronously BEFORE this is
 * even called (parseSkillInvocation's check runs ahead of runTurn/
 * spawnProcess), so there'd otherwise be no ManagedProcess to read from yet
 * regardless of what spawnProcess seeds a brand-new one with. Genuinely
 * empty only for an agent whose process has never once reported in.
 * @param {string} agentId
 * @returns {string[]}
 */
export function getAgentSkills(agentId) {
  return processes.get(agentId)?.skills ?? lastKnownSkills.get(agentId) ?? [];
}

/**
 * Feeds an event that arrived while no explicit turn was in flight
 * (`proc.currentTurn` is null) into a lazily-created accumulator scoped to
 * this unsolicited stretch of output, and — once its `result` lands —
 * hands the finished text/tool calls off to this agent's registered
 * onBackgroundTurn handler, or to onBackgroundError if that `result` was
 * is_error:true (see its docs). Most events seen here are pure
 * informational chatter (background_tasks_changed, task_updated,
 * task_notification) with no assistant/result pair ever following; those
 * are harmless no-ops, since the accumulator only actually fires a handler
 * on a genuine `result`, and (for onBackgroundTurn) only if it captured
 * real content.
 * Exported (alongside createTurnAccumulator) so this routing decision — a
 * `result` with is_error:true going to onBackgroundError, never
 * onBackgroundTurn — has a direct unit test; see
 * tests/unit/background-unprompted-error.test.js. Otherwise only ever
 * called from spawnProcess's own stdout handler against a real process.
 * @param {ManagedProcess} proc
 * @param {{ type: string, [key: string]: unknown }} event
 * @returns {void}
 */
export function handleUnsolicitedEvent(proc, event) {
  if (event.type === 'system' && event.subtype === 'compact_boundary') {
    // Reported immediately, independent of the assistant/result accumulator
    // below — a compaction firing while idle isn't guaranteed to be
    // followed by any actual agent speech (see onBackgroundCompaction's
    // docs), so it can't wait on `done` the way handler() below does.
    const meta = event.compact_metadata;
    if (meta) {
      backgroundCompactionHandlers.get(proc.agentId)?.({
        trigger: meta.trigger ?? 'auto',
        preTokens: meta.pre_tokens ?? null,
        postTokens: meta.post_tokens ?? null,
      });
    }
    return;
  }
  if (event.type !== 'assistant' && event.type !== 'user' && event.type !== 'result') return;

  if (!proc.background) {
    const stream = backgroundStreamHandlers.get(proc.agentId)?.() ?? null;
    proc.backgroundStream = stream;
    proc.background = createTurnAccumulator({ onChunk: stream?.onChunk, onStatus: stream?.onStatus });
  }
  proc.background.handleEvent(event);
  if (!proc.background.done) return;

  const turn = proc.background;
  const stream = proc.backgroundStream ?? null;
  const streamId = stream?.streamId ?? null;
  proc.background = null;
  proc.backgroundStream = null;
  if (turn.usage || turn.totalCostUsd != null) {
    backgroundUsageHandlers.get(proc.agentId)?.({
      usage: turn.usage,
      contextTokens: turn.contextTokens,
      totalCostUsd: turn.totalCostUsd,
      durationMs: turn.durationMs,
      isError: !!turn.errorMessage,
    });
  }
  // A `result` with is_error:true (e.g. the session limit still hadn't
  // cleared when this background retry ran) is a failure, not real agent
  // speech — same distinction runOneTurn's own turn.errorMessage check
  // already makes for an explicit foreground turn. Routed to a dedicated
  // handler instead of onBackgroundTurn's so the caller can react to the
  // failure (e.g. re-arm an auto-continue) without it ever being mistaken
  // for genuine content — see onBackgroundError's docs for why this exists.
  if (turn.errorMessage) {
    const errorHandler = backgroundErrorHandlers.get(proc.agentId);
    if (errorHandler) errorHandler({ errorMessage: turn.errorMessage, streamId });
    else stream?.discard();
    return;
  }
  const handler = backgroundTurnHandlers.get(proc.agentId);
  if ((!turn.fullText && turn.toolCalls.size === 0) || !handler) {
    stream?.discard();
    return;
  }
  handler({
    streamId,
    text: turn.resultText || turn.fullText,
    toolCalls: [...turn.toolCalls.values()],
    sessionId: turn.sessionId,
    permissionDenials: turn.permissionDenials,
    model: turn.model,
  });
}

/**
 * Spawns a fresh persistent process for an agent and registers it. Does
 * NOT write anything to stdin — callers decide when a turn actually starts.
 * @param {import('../store/db.js').Agent} agent
 * @returns {ManagedProcess}
 */
function spawnProcess(agent) {
  const resumed = !!agent.resumeId;
  const child = spawn(CLAUDE_BIN, buildArgs(agent), {
    cwd: agent.workingDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, resumed }, 'agent process spawned');

  // Avoid an unhandled EPIPE if the process exits before/while we write.
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (data) => {
    log.warn({ agentId: agent.id, agentName: agent.name, pid: child.pid, stderr: data.trim() }, 'agent process stderr');
  });

  /** @type {ManagedProcess} */
  const proc = { child, agentId: agent.id, buffer: '', costSoFar: 0, currentTurn: null, background: null, backgroundStream: null, backgroundTasks: [], queue: Promise.resolve(), skills: lastKnownSkills.get(agent.id) ?? [] };

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    proc.buffer += chunk;
    const lines = proc.buffer.split('\n');
    proc.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      const event = withPerTurnCost(proc, parsed);
      // The one piece of information that would have made the Windows MCP
      // investigation trivial instead of requiring hours of empirical
      // spikes: what MCP servers this process actually saw, and whether
      // they connected — now on the record for every single spawn.
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.mcp_servers) && event.mcp_servers.length) {
        log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, mcpServers: event.mcp_servers }, 'mcp server status at turn start');
      }
      // The CLI reports its own invokable skill names on every init — free
      // (no probe turn, no API cost), and always current for whatever this
      // specific process actually has available (built-in + marketplace/
      // plugin + project-local), unlike statically guessing from disk.
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.skills)) {
        proc.skills = event.skills;
        lastKnownSkills.set(agent.id, event.skills);
      }
      if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
        applyBackgroundTasksChanged(proc, event);
      }
      if (proc.currentTurn) {
        proc.currentTurn.handleEvent(event);
      } else {
        handleUnsolicitedEvent(proc, event);
      }
    }
  });

  child.on('exit', (code, sig) => {
    log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, code, signal: sig }, 'agent process exited');
    // Only clean up if this is still the tracked process for this agent —
    // a grant/PATCH-triggered kill can already have registered a NEWER
    // replacement process by the time this OLD one's exit event fires.
    const current = processes.get(agent.id);
    if (current && current.child === child) processes.delete(agent.id);

    // Flush a trailing unparsed line (no final newline) before signaling exit.
    if (proc.buffer.trim()) {
      const event = parseLine(proc.buffer);
      proc.buffer = '';
      if (event) proc.currentTurn?.handleEvent(withPerTurnCost(proc, event));
    }
    proc.currentTurn?.handleExit(code, sig);
    // An unsolicited turn cut off mid-way (stopped, crashed) never reaches
    // its `result` — close whatever live stream was opened for it, and
    // clear any background tasks, which died with the process.
    if (proc.backgroundStream) {
      proc.backgroundStream.discard();
      proc.backgroundStream = null;
      proc.background = null;
    }
    if (proc.backgroundTasks?.length) applyBackgroundTasksChanged(proc, { tasks: [] });
  });

  processes.set(agent.id, proc);
  return proc;
}

/**
 * Eagerly spawns a persistent process for an agent (e.g. right when it
 * joins a chat), so it's already warm before anyone messages it. A no-op
 * if one is already alive. Best-effort: swallows and logs failures (a
 * missing workingDir, say) rather than throwing — the same error already
 * surfaces normally the next time someone actually messages this agent.
 * @param {import('../store/db.js').Agent} agent
 * @returns {void}
 */
export function spawnForAgent(agent) {
  try {
    const existing = processes.get(agent.id);
    if (existing && isAlive(existing)) return;
    if (!existsSync(agent.workingDir)) return;
    spawnProcess(agent);
  } catch (err) {
    log.error({ agentId: agent.id, agentName: agent.name, err }, 'eager spawn failed');
  }
}

/**
 * Runs one turn against an existing (or freshly spawned) persistent
 * process, queued so it never overlaps another in-flight turn on the same
 * process's stdin. Mirrors the return shape the old one-shot
 * runAgentStream always returned.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('./agentRunner.js').ContentBlock[]} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[], wasLocalCommand: boolean, contextCleared: boolean, usage: TurnUsage | null, contextTokens: number | null, totalCostUsd: number | null, durationMs: number | null, model: string | null, compactions: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[] }>}
 */
export function runTurn(agent, content, { onChunk, onStatus, signal }) {
  if (!existsSync(agent.workingDir)) {
    return Promise.reject(new Error(t('errors.workingDirMissing', { name: agent.name, path: agent.workingDir })));
  }

  let proc = processes.get(agent.id);
  if (!proc || !isAlive(proc)) {
    proc = spawnProcess(agent);
  }

  const turnPromise = proc.queue.then(() => runOneTurn(proc, content, { onChunk, onStatus, signal }));
  // Keep the queue chain alive regardless of this turn's outcome, so one
  // failed/rejected turn doesn't wedge every turn queued behind it.
  proc.queue = turnPromise.then(() => {}, () => {});
  return turnPromise;
}

/**
 * @param {ManagedProcess} proc
 * @param {import('./agentRunner.js').ContentBlock[]} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[], wasLocalCommand: boolean, contextCleared: boolean, usage: TurnUsage | null, contextTokens: number | null, totalCostUsd: number | null, durationMs: number | null, model: string | null, compactions: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[] }>}
 */
function runOneTurn(proc, content, { onChunk, onStatus, signal }) {
  return new Promise((resolve, reject) => {
    const turn = createTurnAccumulator({ onChunk, onStatus });
    let stopped = false;
    let settled = false;

    const killForStop = () => {
      stopped = true;
      killTree(proc.child, 'SIGINT', proc.agentId);
    };
    if (signal) {
      if (signal.aborted) killForStop();
      else signal.addEventListener('abort', killForStop, { once: true });
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      proc.currentTurn = null;
      if (signal) signal.removeEventListener('abort', killForStop);
      resolve({
        // turn.fullText is every text block emitted across the whole turn,
        // concatenated in order (see handleEvent above); turn.resultText is
        // just the CLI's own final `result` event text, which — confirmed
        // live — covers only the LAST assistant message, not the full turn,
        // for any turn with a tool call in the middle. Preferring fullText
        // here is what stops that earlier commentary from silently
        // vanishing from the persisted message. Falls back to resultText
        // only for the degenerate case where fullText never got anything
        // (e.g. a turn whose only output was a result-event summary).
        text: turn.fullText || turn.resultText,
        permissionDenials: turn.permissionDenials,
        sessionId: turn.sessionId,
        stopped,
        toolCalls: [...turn.toolCalls.values()],
        wasLocalCommand: turn.wasLocalCommand,
        contextCleared: turn.contextCleared,
        usage: turn.usage,
        contextTokens: turn.contextTokens,
        totalCostUsd: turn.totalCostUsd,
        durationMs: turn.durationMs,
        model: turn.model,
        compactions: turn.compactions,
      });
    };

    // Usage/cost are attached to the rejected Error itself (not just
    // resolved turns) — an errored `result` event (e.g. a session-limit
    // failure) still reports what was actually spent before it hit the
    // wall, via turn.handleEvent already having run on that same event
    // before this is called. See maybeScheduleAutoContinue's caller in
    // ws/handler.js, which logs this on the 'turn errored' line — that's
    // what makes a token-burn incident like a shared account limit getting
    // exhausted mid-turn debuggable after the fact instead of guesswork.
    const fail = (message) => {
      if (settled) return;
      settled = true;
      proc.currentTurn = null;
      if (signal) signal.removeEventListener('abort', killForStop);
      const err = new Error(message);
      err.usage = turn.usage;
      err.contextTokens = turn.contextTokens;
      err.totalCostUsd = turn.totalCostUsd;
      err.durationMs = turn.durationMs;
      err.model = turn.model;
      err.compactions = turn.compactions;
      err.contextCleared = turn.contextCleared;
      reject(err);
    };

    proc.currentTurn = {
      handleEvent(event) {
        turn.handleEvent(event);
        if (event.type !== 'result') return;
        // A `result` event with is_error:true (e.g. an invalid --resume
        // flag, or another flag the CLI rejects outright) is a failure, not
        // a successful empty-text reply — see turn.errorMessage's docs.
        // Reject here rather than falling through to handleExit's own
        // non-zero-exit check below: this event already settles the turn
        // (turn.done = true), so handleExit's `if (settled) return` would
        // otherwise just silently no-op once the process actually exits a
        // moment later, and the caller would be left with `finish()`'s
        // empty-string "success" instead of ever seeing the real error.
        if (turn.errorMessage) {
          fail(t('errors.claudeExecutionError', { message: turn.errorMessage }));
          return;
        }
        if (looksLikeMcpAuthFailure(turn.resultText)) {
          // Don't block returning this turn's (already-user-visible) error
          // text — evict in the background so the conversation isn't
          // stuck waiting on a kill+exit round-trip it doesn't need to see.
          log.warn({ agentId: proc.agentId }, 'mcp auth failure detected in turn output; evicting process so the next turn spawns fresh and re-reads current auth');
          killAgent(proc.agentId).catch(() => {});
        }
        finish();
      },
      handleExit(code) {
        if (settled) return;
        // The process died mid-turn with nothing captured yet (a crash,
        // not a graceful interrupt-then-exit, which already resolved via
        // the 'result' event above before this ever fires).
        if (code !== 0 && !turn.resultText && !turn.fullText) {
          settled = true;
          if (signal) signal.removeEventListener('abort', killForStop);
          reject(new Error(t('errors.claudeExitCode', { code })));
          return;
        }
        finish();
      },
    };

    proc.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

/**
 * Kills an agent's live process (if any) and waits for it to actually
 * exit before resolving — used for explicit teardown (agent left/deleted,
 * chat deleted) and whenever a grant or PATCH invalidates a startup CLI
 * flag (--add-dir/--allowedTools/--dangerously-skip-permissions) baked
 * into the currently-running process, which has no way to pick up the
 * change live.
 *
 * Awaiting matters: SIGTERM delivery and process teardown aren't
 * synchronous, so a caller that kills and then immediately starts a new
 * turn (e.g. GRANT_PERMISSION's auto-continue) could otherwise still find
 * the old, dying-but-not-yet-reaped process in the registry and write the
 * new turn's stdin message into it instead of a correctly-flagged fresh
 * spawn.
 *
 * By default (`immediate: false`) this waits for `proc.queue` — i.e. any
 * turn currently running against this process — to finish BEFORE sending
 * the signal, rather than cutting it off mid-stream. Reported live: an
 * MCP client (another agent in the same chat, managing its own teammates)
 * removed an agent from the chat — and this function fired — while that
 * agent's own turn was still mid-flight, truncating its reply and
 * surfacing as an error. For an idle agent (the overwhelmingly common
 * case — a flag change or removal normally happens between turns) `queue`
 * is already resolved, so this adds no delay at all; it only matters when
 * a removal/flag-change genuinely races a live turn. Growing an
 * in-flight turn to full completion before tearing the process down costs
 * nothing structurally since nothing here depends on timely teardown
 * except shutdown (see killAll below, which opts out via
 * `immediate: true` — the process is going down regardless, so waiting
 * out a live turn there would only make shutdown hang).
 * @param {string} agentId
 * @param {{ immediate?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function killAgent(agentId, { immediate = false } = {}) {
  const proc = processes.get(agentId);
  if (!proc) return Promise.resolve();

  const sendKill = () => {
    // Re-read from the registry rather than closing over `proc`: while we
    // were waiting on its queue, that process could already have exited on
    // its own (crash) and been replaced by a freshly-spawned one — the
    // thing we actually want gone is whatever this agent is CURRENTLY
    // running, not the specific object captured above.
    const live = processes.get(agentId);
    if (!live || !isAlive(live)) return Promise.resolve();
    return new Promise((resolve) => {
      live.child.once('exit', () => resolve());
      killTree(live.child, 'SIGTERM', agentId);
    });
  };

  return immediate ? sendKill() : proc.queue.then(sendKill, sendKill);
}

/**
 * Kills every live agent process and waits for them all to actually exit
 * — used for graceful server shutdown, so a plain `kill <pid>` on the
 * Node process (which does NOT forward to children not in their own
 * process group) doesn't orphan them. Passes `immediate: true` to
 * killAgent: the whole server is going down regardless, so waiting out
 * whatever turn happens to be running (killAgent's normal, safer default)
 * would just make shutdown hang on it instead of actually being graceful.
 * @returns {Promise<void>}
 */
export async function killAll() {
  await Promise.all([...processes.keys()].map((agentId) => killAgent(agentId, { immediate: true })));
}
