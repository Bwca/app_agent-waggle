/**
 * @fileoverview The agent-provider registry: which CLI an agent actually
 * runs as (`claude` today, others later), and the contract every provider
 * implements so agentProcessManager.js can own process lifecycle — spawn,
 * per-agent turn queue, stop/kill, unsolicited-output routing — without
 * knowing any one CLI's flags or wire format.
 *
 * A provider owns everything that differs per CLI: the command line, how a
 * turn is written to stdin, how a stdout line is parsed, and how its events
 * become the provider-neutral shapes below (a TurnAccumulator for a turn's
 * content, a ProcessSignal for process-level facts like skills or
 * background tasks). Adding a provider means implementing AgentProvider and
 * registering it in `providers` — nothing in agentProcessManager.js changes.
 */

import { claudeProvider } from './claude.js';
import { opencodeProvider } from './opencode.js';
import { DEFAULT_PROVIDER_ID } from '../../public/agentProviders.js';

/**
 * Every provider this app currently assumes: a persistent process, kept
 * alive across turns, reading one turn per stdin line and writing NDJSON
 * to stdout. A CLI without a streaming-input mode (one process per turn,
 * resumed by session id) needs its own lifecycle in agentProcessManager.js
 * before it can be registered here.
 * @typedef {Object} AgentProvider
 * @property {string} id - Stable key, stored per agent (see providerForAgent).
 * @property {string} displayName - Shown in user-facing errors.
 * @property {(agent: import('../../store/db.js').Agent, options?: { autocompactDefault?: string | null }) => { command: string, args: string[] }} spawnCommand -
 *   `autocompactDefault` is the compaction window from Settings (see
 *   setAutocompactDefault in agentProcessManager.js); a provider with no
 *   such notion ignores it.
 * @property {(agent?: { workingDir?: string }) => { command: string, args: string[], source: BinarySource }} versionCommand - A
 *   cheap no-model-call invocation, used to verify the binary resolves
 *   before an agent is created and to tell the New Agent form which
 *   providers it can offer (see agentRunner.js's verifyProviderAvailable).
 *   Gets the agent-to-be when there is one, for a provider that resolves its
 *   binary per project, and says where the binary it chose came from.
 * @property {(agent?: { workingDir?: string }) => { command: string, args: string[] }} [modelsCommand] -
 *   Lists the model IDs an agent of this provider could run, one per line
 *   on stdout, run in the agent-to-be's working directory since a project
 *   can configure its own models (see agentRunner.js's listProviderModels).
 *   For the model picker of a provider with no aliases of its own; one
 *   without it only takes a typed model ID.
 * @property {(state: object, content: import('../agentRunner.js').ContentBlock[]) => void | Promise<void>} startTurn -
 *   Writes whatever starts one turn to the process, through the `write` the
 *   state was created with. A provider whose protocol needs a handshake
 *   before the first turn does it here, so it can be async; a rejection
 *   fails the turn.
 * @property {(line: string) => object | null} parseLine
 * @property {(agent: import('../../store/db.js').Agent, io: { write: (data: string) => void }) => object} createProcessState -
 *   Per-process state the provider needs across events (e.g. a running-total
 *   baseline, or a protocol connection), created once per spawn. `write`
 *   goes to the process's stdin.
 * @property {(state: object, event: object) => object | null} normalizeEvent -
 *   Runs on every parsed event, foreground or unsolicited, before anything
 *   else reads it. Null means the provider consumed the event itself (a
 *   reply to its own handshake, say) and nothing else should see it.
 * @property {(event: object) => ProcessSignal} inspectEvent
 * @property {(callbacks?: { onChunk?: (text: string) => void, onStatus?: (status: string) => void }) => TurnAccumulator} createTurnAccumulator
 * @property {(text: string) => boolean} looksLikeAuthFailure - True when a
 *   finished turn's text means the process holds stale auth and should be
 *   respawned.
 * @property {string[]} commandDirs - Where a project keeps its custom slash
 *   commands (`*.md` files), relative to the agent's workingDir.
 * @property {Set<string>} builtinCommands - The CLI's own commands that are
 *   always offered and forwarded, whether or not its process reported them
 *   (see commands.js's ALLOWED_BUILTIN_COMMANDS for Claude's).
 * @property {(toolName: string, value: string) => PermissionGrant} grantFor -
 *   What granting one denied tool call (as the permission card shows it:
 *   a path, a command, or a JSON dump of its input) should store on the
 *   agent. A grant always respawns the agent's process, so a provider reads
 *   the stored grants back at spawn time, as flags or however it applies them.
 * @property {(toolName: string, value: string) => string[] | null} overlappingPatterns -
 *   The patterns a denial would grant, for a tool whose grants can cover one
 *   another's (see agentRunner.js's dedupePermissionDenials), or null.
 */

/**
 * Where a provider found its binary: an env var override, a copy pinned by
 * the agent's own project, PATH, or the CLI's own install location in the
 * user's home directory.
 * @typedef {'env' | 'project' | 'path' | 'home'} BinarySource
 */

/**
 * Exactly one of the two is set.
 * @typedef {Object} PermissionGrant
 * @property {string} [path] - A directory to add to agent.extraAllowedPaths.
 * @property {string[]} [patterns] - Patterns to add to agent.allowedToolPatterns.
 */

/**
 * What a single event says about the process as a whole, independent of
 * whichever turn (if any) it belongs to. Every field but isTurnContent is
 * present only when the event carries it.
 * @typedef {Object} ProcessSignal
 * @property {boolean} isTurnContent - True if this event is part of a turn's
 *   own output (text, tool calls, tool results, the turn's end) — what
 *   starts or continues an unsolicited turn when no explicit one is in flight.
 * @property {string[]} [skills] - The skill names this process can invoke.
 * @property {object[]} [mcpServers] - MCP server status, for logging.
 * @property {BackgroundTask[]} [backgroundTasks] - The complete current list.
 * @property {Compaction} [compaction]
 */

/**
 * @typedef {Object} Compaction
 * @property {'auto' | 'manual'} trigger
 * @property {number | null} preTokens
 * @property {number | null} postTokens
 */

/**
 * @typedef {Object} BackgroundTask
 * @property {string} id - The CLI's own task id
 * @property {string} type - e.g. "local_bash"
 * @property {string} description - The CLI's own human-readable label
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} id - The tool_use content block's own id — links it to
 *   its eventual tool_result.
 * @property {string} name - Raw tool name, e.g. "Bash", "Edit", or an MCP
 *   tool's full name like "mcp__linear__list_issues".
 * @property {string} label - Human "what's happening" summary (see
 *   claude.js's describeToolUse) — the same text already streamed live as
 *   AGENT_STREAM_STATUS, kept here so it's still visible after the fact.
 * @property {string} result - The tool's own output (stdout, file diff,
 *   MCP response, ...), capped via truncateToolResult — empty string if no
 *   matching tool_result ever arrived (e.g. the call was permission-denied).
 * @property {boolean} isError - True if the tool_result reported is_error.
 */

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
 * @property {import('../agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {Map<string, ToolCall>} toolCalls
 * @property {boolean} done - Set once the turn's end (for Claude, a `result`
 *   event) has been fed in.
 * @property {boolean} wasLocalCommand - True if this turn's `assistant`
 *   event was the CLI's synthetic local-command reply, not a real model
 *   turn — see claude.js's handleEvent.
 * @property {string | null} errorMessage - Set once a `result` event with
 *   `is_error: true` has been fed in — see claude.js's handleEvent. Null for a
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
 *   than one in a single turn. Usually empty; see claude.js's buildArgs
 *   (`--autocompact`) for what triggers this.
 * @property {(event: object) => void} handleEvent
 */


export { DEFAULT_PROVIDER_ID };

/** @type {Map<string, AgentProvider>} */
const providers = new Map([claudeProvider, opencodeProvider].map((provider) => [provider.id, provider]));

/**
 * @param {string} [id]
 * @returns {AgentProvider}
 */
export function getProvider(id = DEFAULT_PROVIDER_ID) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown agent provider: ${id}`);
  return provider;
}

/**
 * Every registered provider, the default first.
 * @returns {AgentProvider[]}
 */
export function listProviders() {
  return [...providers.values()];
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function hasProvider(id) {
  return providers.has(id);
}

/**
 * The provider an agent runs as. Every stored agent has one; the fallback
 * is for an agent-shaped object that doesn't (a test fixture, say).
 * @param {import('../../store/db.js').Agent} agent
 * @returns {AgentProvider}
 */
export function providerForAgent(agent) {
  return getProvider(agent.provider ?? DEFAULT_PROVIDER_ID);
}
