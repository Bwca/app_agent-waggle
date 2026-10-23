/**
 * @fileoverview The Claude Code CLI as an agent provider (see index.js for
 * the contract): a persistent `claude --print --input-format=stream-json
 * --output-format=stream-json` process, and everything specific to its
 * flags and stream-json wire format — moved here unchanged from
 * agentProcessManager.js, which now only owns process lifecycle.
 */

import { basename, dirname } from 'path';
import { commandGrants } from './shellCommands.js';
import { ALLOWED_BUILTIN_COMMANDS } from '../commands.js';

/** @typedef {import('./index.js').ToolCall} ToolCall */
/** @typedef {import('./index.js').TurnAccumulator} TurnAccumulator */
/** @typedef {import('./index.js').Compaction} Compaction */
/** @typedef {import('./index.js').ProcessSignal} ProcessSignal */

// Resolved from PATH by default so this works on any machine; override via
// env var if a machine's `claude` isn't on PATH under the expected name.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Context size, in the CLI's own `--autocompact` syntax, at which an agent's
 * session gets summarized, when neither the agent itself
 * (agent.autocompactOverride) nor Settings (spawnCommand's
 * `autocompactDefault`) says otherwise. Overridable via APP_AUTOCOMPACT
 * (the CLI accepts 'auto', or 100k–1M, e.g. "300k" or "300000").
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
export const AUTOCOMPACT_WINDOW = process.env.APP_AUTOCOMPACT || '200k';

/**
 * The names this app's own MCP server (server/mcp/) may be registered under
 * in the user's Claude config: APP_MCP_SERVER_NAME for anyone who chose
 * their own, `agentwaggle` from the README's setup command, and `clauhort`,
 * the app's old name, which registrations made before the rename still
 * use. Every one is guarded, so nobody has to re-register for the guard to
 * keep working.
 */
const MCP_SERVER_NAMES = [...new Set([process.env.APP_MCP_SERVER_NAME, 'agentwaggle', 'clauhort'].filter(Boolean))];

/** Stream status while the CLI compacts an agent's context, and once it's done. */
const COMPACTING_STATUS = '🗜️ Compacting context…';
const COMPACTED_STATUS = '🗜️ Context compacted, continuing…';

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
 * @param {{ costSoFar: number }} state - The process's provider state
 *   (see createProcessState). Mutated: costSoFar advances to the event's
 *   running total.
 * @param {object} event
 * @returns {object}
 */
export function withPerTurnCost(state, event) {
  if (event.type !== 'result' || typeof event.total_cost_usd !== 'number') return event;
  const turnCost = Math.max(0, event.total_cost_usd - state.costSoFar);
  state.costSoFar = Math.max(state.costSoFar, event.total_cost_usd);
  return { ...event, total_cost_usd: turnCost };
}

/**
 * Builds the persistent process's CLI args. Every one of these is baked in
 * at spawn time, which is why a change to any of them (a permission grant,
 * a workingDir/YOLO/resumeId PATCH) has to kill the live process so the
 * next turn respawns with the new flags.
 * @param {import('../../store/db.js').Agent} agent
 * @param {{ autocompactDefault?: string | null }} [options] - The default
 *   compaction window from Settings, for an agent with no override of its own.
 * @returns {string[]}
 */
function buildArgs(agent, { autocompactDefault } = {}) {
  const args = [
    '--print',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
    // Lets the CLI summarize its own older context once a resumed session's
    // cache grows past AUTOCOMPACT_WINDOW, instead of every request paying
    // to re-read a huge history in full. Lossy-but-graceful, unlike dropping
    // resumeId outright (which forgets everything).
    '--autocompact', agent.autocompactOverride || autocompactDefault || AUTOCOMPACT_WINDOW,
    // Every agent sees the user's own MCP servers, this app's included when
    // it's registered at user scope, and send_message posts as the user.
    // Reported live: agents answered through it, so the chat showed the user
    // saying things they never wrote, and the asAgentId parameter added to
    // stop that was simply left out by some agents. An agent's normal reply
    // already reaches the chat, so it loses nothing it needs; every other
    // tool of this app's (reading the chat, adding/removing teammates) stays.
    // Confirmed against the real CLI (2.1.301): this removes the tool under
    // both acceptEdits and --dangerously-skip-permissions. The "=" form
    // matters: --disallowedTools takes several values, and a bare next
    // argument would be swallowed as another tool name. A comma list in that
    // form removes every tool in it (2.1.306).
    `--disallowedTools=${MCP_SERVER_NAMES.map((name) => `mcp__${name}__send_message`).join(',')}`,
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
 * process's own spawn time (see agentProcessManager.js's spawnProcess) —
 * it is NEVER re-read for the life of the process. If a user re-authenticates externally
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
 * The text/tool_use/tool_result/result parsing at the heart of a turn —
 * shared by agentProcessManager.js's runOneTurn (an explicitly-initiated
 * turn, streamed live via onChunk/onStatus) and handleUnsolicitedEvent (a
 * turn the CLI resumes and runs entirely on its own — see that function's
 * docs). Previously this
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
        // otherwise visible anywhere (see buildArgs' --autocompact docs) —
        // surfaced here so ws/handler.js can post a system note into the
        // chat instead of it silently passing.
        const compaction = parseCompaction(event);
        if (compaction) turn.compactions.push(compaction);
      } else if (event.type === 'system' && event.subtype === 'status' && (event.status === 'compacting' || event.compact_result)) {
        // Compaction can take minutes on a large context, and its
        // compact_boundary (above) only arrives once it's done, so until
        // then the turn looked stuck. Reported live: an agent sat silent for
        // two and a half minutes while its context compacted at the start of
        // a turn. Confirmed against the real CLI (2.1.301): a
        // {"subtype":"status","status":"compacting"} event marks the start,
        // and one with status null and a compact_result marks the end.
        onStatus?.(event.status === 'compacting' ? COMPACTING_STATUS : COMPACTED_STATUS);
      } else if (event.type === 'conversation_reset' || (event.type === 'system' && event.subtype === 'conversation_reset')) {
        // Since at least CLI 2.1.301 this is a top-level
        // {"type":"conversation_reset"}, no longer a system subtype —
        // confirmed against a raw stream-json run. Matching only the old
        // shape missed every "/clear", so its empty result was saved as a
        // blank reply. Both shapes are kept, for older CLIs.
        //
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
 * Reads a `system`/`compact_boundary` event's metadata — see
 * createTurnAccumulator's handling of it for the event's shape.
 * @param {{ compact_metadata?: { trigger?: 'auto' | 'manual', pre_tokens?: number, post_tokens?: number } }} event
 * @returns {Compaction | null}
 */
function parseCompaction(event) {
  const meta = event.compact_metadata;
  if (!meta) return null;
  return {
    trigger: meta.trigger ?? 'auto',
    preTokens: meta.pre_tokens ?? null,
    postTokens: meta.post_tokens ?? null,
  };
}

/**
 * @param {{ type: string, subtype?: string, [key: string]: unknown }} event
 * @returns {ProcessSignal}
 */
function inspectEvent(event) {
  /** @type {ProcessSignal} */
  const signal = { isTurnContent: event.type === 'assistant' || event.type === 'user' || event.type === 'result' };
  if (event.type !== 'system') return signal;
  if (event.subtype === 'init') {
    if (Array.isArray(event.mcp_servers) && event.mcp_servers.length) signal.mcpServers = event.mcp_servers;
    // The CLI reports its own invokable skill names on every init — free
    // (no probe turn, no API cost), and always current for whatever this
    // specific process actually has available (built-in + marketplace/
    // plugin + project-local), unlike statically guessing from disk.
    if (Array.isArray(event.skills)) signal.skills = event.skills;
  } else if (event.subtype === 'background_tasks_changed') {
    // Confirmed directly against the installed CLI: carries the COMPLETE
    // current list (not a delta), both when a task starts and when it
    // finishes (an empty list).
    signal.backgroundTasks = Array.isArray(event.tasks)
      ? event.tasks.map((task) => ({
          id: String(task.task_id ?? ''),
          type: String(task.task_type ?? ''),
          description: String(task.description ?? ''),
        }))
      : [];
  } else if (event.subtype === 'compact_boundary') {
    const compaction = parseCompaction(event);
    if (compaction) signal.compaction = compaction;
  }
  return signal;
}

/**
 * The stdin line that starts one turn: a single stream-json user message.
 * @param {import('../agentRunner.js').ContentBlock[]} content
 * @returns {string}
 */
export function encodeTurn(content) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

// Tool names whose permission_denials carry a real filesystem path
// (tool_input.file_path) — these are the ones `extraAllowedPaths`/`--add-dir`
// can actually authorize. Anything else (Bash, WebFetch, etc.) needs
// allowedToolPatterns/`--allowedTools` instead — see the Agent typedef in
// db.js for why the two grant mechanisms are kept separate.
export const FILE_PATH_TOOLS = ['Write', 'Edit', 'Read', 'NotebookEdit'];

/**
 * Derives the scoped `--allowedTools` pattern(s) to grant for a denied,
 * non-file-path tool call. Called server-side (handler.js's GRANT_PERMISSION
 * handler, through claudeProvider.grantFor) on the same flattened "value" string the permission card already
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
 * Where two tokens wouldn't say what runs ("python3 -c", "bash -c", "eval
 * $(…)"), the sub-command is granted exactly, `Bash(<command>)`, which the
 * CLI matches only verbatim, and a loop is granted by the commands inside
 * it, which is how the CLI judges one (both checked against v2.1.308) — see
 * commandGrants.
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
  return commandGrants(value).map(({ text, exact }) => (exact ? `Bash(${text})` : `Bash(${text}:*)`));
}

/**
 * What granting one denied tool call authorizes: the containing directory
 * for a file-path tool, since `--add-dir` on a file path is silently a
 * no-op (confirmed empirically: --add-dir <file> still gets denied,
 * --add-dir <dirname(file)> doesn't), else `--allowedTools` patterns.
 * @param {string} toolName
 * @param {string} value - The denial's flattened display value
 * @returns {import('./index.js').PermissionGrant}
 */
function grantFor(toolName, value) {
  if (FILE_PATH_TOOLS.includes(toolName)) return { path: dirname(value) };
  return { patterns: deriveToolPatterns(toolName, value) };
}

/** @type {import('./index.js').AgentProvider} */
export const claudeProvider = {
  id: 'claude',
  displayName: 'Claude',
  // Its own keys and settings (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN,
  // CLAUDE_CONFIG_DIR, ...) reach no other provider's agents, and it keeps
  // the user's git and SSH credentials, as it always had (see agentEnv.js).
  env: {
    owns: (name) => name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE'),
    userCredentials: true,
  },
  spawnCommand: (agent, options) => ({ command: CLAUDE_BIN, args: buildArgs(agent, options) }),
  versionCommand: () => ({ command: CLAUDE_BIN, args: ['--version'], source: process.env.CLAUDE_BIN ? 'env' : 'path' }),
  startTurn: (state, content) => state.write(encodeTurn(content)),
  parseLine,
  createProcessState: (_agent, { write }) => ({ write, costSoFar: 0 }),
  normalizeEvent: withPerTurnCost,
  inspectEvent,
  createTurnAccumulator,
  looksLikeAuthFailure: looksLikeMcpAuthFailure,
  commandDirs: ['.claude/commands'],
  builtinCommands: ALLOWED_BUILTIN_COMMANDS,
  grantFor,
  // Only Bash patterns can cover one another: a file-path tool's "pattern"
  // is just its bare name, so comparing those would hide a second,
  // different file's request.
  overlappingPatterns: (toolName, value) => (toolName === 'Bash' ? deriveToolPatterns('Bash', value) : null),
};
