/**
 * @fileoverview opencode as an agent provider (see index.js for the
 * contract): a persistent `opencode acp` process, spoken to over the Agent
 * Client Protocol — newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * Confirmed against opencode 1.19.3 (not assumed from the ACP spec alone):
 * - One process serves any number of turns. `initialize` and then
 *   `session/new` (or `session/load` to resume) must come first, so the
 *   handshake runs inside the first turn's startTurn.
 * - `session/load` replays the whole session as session/update
 *   notifications before it answers. Those are history, not a turn's
 *   output, so they're dropped while it runs.
 * - A turn is a `session/prompt` request: text streams as
 *   agent_message_chunk updates, tools as tool_call/tool_call_update, and
 *   the turn ends with the request's own response ({ stopReason, usage }).
 * - Permission prompts arrive mid-turn as a `session/request_permission`
 *   request. This app has no way to ask the user while a turn runs, so the
 *   provider answers itself from the agent's stored grants (see
 *   decidePermission), the same grants Claude gets as spawn flags. A
 *   rejected call fails the tool and the model ends its turn, which then
 *   shows the usual permission card. Granting respawns the process, which
 *   resumes the session with the new grant in place.
 * - `session/set_config_option` with configId "model" switches the model
 *   of a live session, which is how modelOverride is applied.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, delimiter, dirname, join, relative, isAbsolute } from 'path';
import { commandPrefixes } from './shellCommands.js';

/** @typedef {import('./index.js').ToolCall} ToolCall */
/** @typedef {import('./index.js').TurnAccumulator} TurnAccumulator */
/** @typedef {import('./index.js').ProcessSignal} ProcessSignal */
/** @typedef {import('../agentRunner.js').PermissionDenial} PermissionDenial */

/** The ACP protocol version this client speaks. */
const PROTOCOL_VERSION = 1;

/** The shell tool's name, as opencode's own tool list calls it. */
const SHELL_TOOL = 'bash';

/**
 * Tool kinds (ACP's ToolKind) whose call acts on a file path, which a
 * directory grant (extraAllowedPaths) can authorize, the counterpart of
 * Claude's FILE_PATH_TOOLS.
 */
const FILE_KINDS = new Set(['read', 'edit', 'delete', 'move']);

/** A tool's name when its tool_call event didn't name it, by ACP ToolKind. */
const TOOL_NAME_BY_KIND = { execute: SHELL_TOOL, edit: 'edit', read: 'read', delete: 'delete', move: 'move', search: 'grep', fetch: 'webfetch' };

/** Same cap and reasoning as providers/claude.js's MAX_TOOL_RESULT_CHARS. */
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Where opencode's own install script puts the binary when nothing else is
 * asked for. Often not on the PATH the server inherits (it's added by a
 * shell profile line), so it's checked by path rather than left to PATH.
 */
const HOME_INSTALL_BIN = join(homedir(), '.opencode', 'bin', 'opencode');

/**
 * Finds an executable on PATH, the way a shell would.
 * @param {string} name
 * @returns {string | null}
 */
function findOnPath(name) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const candidate of names) {
      if (existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return null;
}

/**
 * The opencode binary for an agent, and where it was found, first match
 * wins: OPENCODE_BIN; the copy the project itself pins
 * (`node_modules/.bin/opencode` in its workingDir, as opencode's npm
 * package installs it); `opencode` on PATH; opencode's own install
 * location (HOME_INSTALL_BIN). With none of them, plain `opencode`, which
 * then fails to spawn with a clear ENOENT.
 * @param {string} [workingDir]
 * @returns {{ command: string, source: import('./index.js').BinarySource }}
 */
export function locateBin(workingDir) {
  if (process.env.OPENCODE_BIN) return { command: process.env.OPENCODE_BIN, source: 'env' };
  const local = workingDir ? join(workingDir, 'node_modules', '.bin', 'opencode') : null;
  if (local && existsSync(local)) return { command: local, source: 'project' };
  const onPath = findOnPath('opencode');
  if (onPath) return { command: onPath, source: 'path' };
  if (existsSync(HOME_INSTALL_BIN)) return { command: HOME_INSTALL_BIN, source: 'home' };
  return { command: 'opencode', source: 'path' };
}

/**
 * @param {string} [workingDir]
 * @returns {string}
 */
export function resolveBin(workingDir) {
  return locateBin(workingDir).command;
}

/**
 * Parses one stdout line as a JSON-RPC message.
 * @param {string} line
 * @returns {object | null}
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
 * @typedef {Object} OpencodeState
 * @property {import('../../store/db.js').Agent} agent - As it was at spawn;
 *   anything that changes how a process should behave respawns it.
 * @property {(data: string) => void} write
 * @property {number} nextId
 * @property {Map<number, { resolve: (result: any) => void, reject: (err: Error) => void }>} pending -
 *   This client's own requests still waiting on a response.
 * @property {Promise<void> | null} ready - The handshake, once started.
 * @property {boolean} replaying - True while session/load replays history.
 * @property {string | null} sessionId
 * @property {string | null} model - The session's current model.
 * @property {number | null} promptId - The in-flight session/prompt request.
 * @property {number | null} cost - The session's running cost, as last reported.
 * @property {number} turnStartCost - `cost` when the current turn started.
 * @property {Map<string, string>} toolNames - Tool name per toolCallId.
 */

/**
 * @param {import('../../store/db.js').Agent} agent
 * @param {{ write: (data: string) => void }} io
 * @returns {OpencodeState}
 */
function createProcessState(agent, { write }) {
  return {
    agent,
    write,
    nextId: 1,
    pending: new Map(),
    ready: null,
    replaying: false,
    sessionId: agent.resumeId ?? null,
    model: null,
    promptId: null,
    cost: null,
    turnStartCost: 0,
    toolNames: new Map(),
  };
}

/**
 * @param {OpencodeState} state
 * @param {object} message
 */
function send(state, message) {
  state.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

/**
 * Sends a request and resolves with its result, or rejects with its error.
 * @param {OpencodeState} state
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>}
 */
function request(state, method, params) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    send(state, { id, method, params });
  });
}

/**
 * Reads the session's model off the config options a session/new,
 * session/load or set_config_option response (or a config_option_update)
 * reports.
 * @param {OpencodeState} state
 * @param {unknown} configOptions
 */
function readConfigOptions(state, configOptions) {
  if (!Array.isArray(configOptions)) return;
  const model = configOptions.find((option) => option?.id === 'model');
  if (typeof model?.currentValue === 'string') state.model = model.currentValue;
}

/**
 * Opens (or resumes) the agent's session and applies its model override.
 * @param {OpencodeState} state
 * @returns {Promise<void>}
 */
async function handshake(state) {
  const { agent } = state;
  await request(state, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    // Nothing offered: opencode reads and writes files and runs commands
    // itself, in the agent's working directory.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  let session;
  if (state.sessionId) {
    state.replaying = true;
    try {
      session = await request(state, 'session/load', { sessionId: state.sessionId, cwd: agent.workingDir, mcpServers: [] });
    } finally {
      state.replaying = false;
    }
  } else {
    session = await request(state, 'session/new', { cwd: agent.workingDir, mcpServers: [] });
    state.sessionId = session.sessionId;
  }
  readConfigOptions(state, session?.configOptions);
  if (agent.modelOverride && agent.modelOverride !== state.model) {
    const updated = await request(state, 'session/set_config_option', { sessionId: state.sessionId, configId: 'model', value: agent.modelOverride });
    readConfigOptions(state, updated?.configOptions);
  }
}

/**
 * Converts a turn's content blocks to ACP prompt content.
 * @param {import('../agentRunner.js').ContentBlock[]} content
 * @returns {object[]}
 */
function toPrompt(content) {
  return content.map((block) => (block.type === 'image'
    ? { type: 'image', mimeType: block.source.media_type, data: block.source.data }
    : { type: 'text', text: block.text }));
}

/**
 * @param {OpencodeState} state
 * @param {import('../agentRunner.js').ContentBlock[]} content
 * @returns {Promise<void>}
 */
async function startTurn(state, content) {
  state.ready ??= handshake(state);
  try {
    await state.ready;
  } catch (err) {
    // Not cached: the next turn tries again instead of failing forever.
    state.ready = null;
    throw err;
  }
  state.turnStartCost = state.cost ?? 0;
  state.promptId = state.nextId++;
  send(state, { id: state.promptId, method: 'session/prompt', params: { sessionId: state.sessionId, prompt: toPrompt(content) } });
}

/**
 * Whether `path` is `dir` or inside it.
 * @param {string} path
 * @param {string} dir
 * @returns {boolean}
 */
function isWithin(path, dir) {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Describes a permission request's tool call the way a denial records it,
 * so the permission card shows a path or a command like it does for Claude.
 * @param {OpencodeState} state
 * @param {{ toolCallId: string, kind?: string, rawInput?: Record<string, unknown>, locations?: { path: string }[] }} toolCall
 * @returns {PermissionDenial}
 */
function describeRequest(state, toolCall) {
  const input = toolCall.rawInput ?? {};
  const name = state.toolNames.get(toolCall.toolCallId) ?? TOOL_NAME_BY_KIND[toolCall.kind] ?? toolCall.kind ?? 'tool';
  const path = input.filePath ?? input.path ?? toolCall.locations?.[0]?.path;
  let toolInput = input;
  if (typeof input.command === 'string') toolInput = { command: input.command };
  else if (FILE_KINDS.has(toolCall.kind) && typeof path === 'string') toolInput = { file_path: path };
  return { tool_name: name, tool_use_id: toolCall.toolCallId, tool_input: toolInput };
}

/**
 * Answers a permission request from the agent's stored grants, the way
 * Claude's spawn flags would: everything under YOLO mode; a file tool on a
 * path inside the working directory or a granted directory (Claude's
 * acceptEdits); a command whose every sub-command has a granted pattern;
 * any other tool granted by name.
 * @param {import('../../store/db.js').Agent} agent
 * @param {PermissionDenial} call
 * @returns {boolean}
 */
export function decidePermission(agent, call) {
  if (agent.dangerouslySkipPermissions) return true;
  const granted = new Set(agent.allowedToolPatterns ?? []);
  if (granted.has(call.tool_name)) return true;
  const { file_path: path, command } = call.tool_input;
  if (typeof path === 'string') {
    return [agent.workingDir, ...(agent.extraAllowedPaths ?? [])].some((dir) => isWithin(path, dir));
  }
  if (typeof command === 'string') {
    const patterns = deriveToolPatterns(call.tool_name, command);
    return patterns.length > 0 && patterns.every((pattern) => granted.has(pattern));
  }
  return false;
}

/**
 * The patterns granting a command authorizes, one per sub-command, in this
 * provider's own syntax ("bash(git add:*)"). Only this file reads them back.
 * @param {string} toolName
 * @param {string} command
 * @returns {string[]}
 */
function deriveToolPatterns(toolName, command) {
  return commandPrefixes(command).map((prefix) => (prefix ? `${toolName}(${prefix}:*)` : toolName));
}

/**
 * Picks the option with the given ACP PermissionOptionKind prefix ("allow"
 * or "reject"), preferring a one-time one: a grant is stored by this app,
 * never by opencode, so it's the same everywhere the agent runs.
 * @param {{ optionId: string, kind: string }[]} options
 * @param {'allow' | 'reject'} kind
 * @returns {string | undefined}
 */
function pickOption(options, kind) {
  return (options.find((o) => o.kind === `${kind}_once`) ?? options.find((o) => o.kind?.startsWith(kind)))?.optionId;
}

/**
 * Handles a request opencode sends this client. A permission request is
 * answered here and, if rejected, becomes a `permission_denied` event for
 * the turn; anything else is refused, since no other capability was offered.
 * @param {OpencodeState} state
 * @param {{ id: number | string, method: string, params?: any }} message
 * @returns {object | null}
 */
function answerRequest(state, message) {
  if (message.method !== 'session/request_permission') {
    send(state, { id: message.id, error: { code: -32601, message: `Method not supported: ${message.method}` } });
    return null;
  }
  const options = message.params?.options ?? [];
  const call = describeRequest(state, message.params?.toolCall ?? {});
  const allowed = decidePermission(state.agent, call);
  const optionId = pickOption(options, allowed ? 'allow' : 'reject');
  const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
  send(state, { id: message.id, result: { outcome } });
  return allowed ? null : { type: 'permission_denied', denial: call };
}

/** session/update kinds that only describe a turn's own output. */
const TURN_UPDATES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);

/**
 * Routes one incoming JSON-RPC message: responses to this client's own
 * requests are consumed (the turn's own session/prompt response becomes a
 * `turn_end` event), requests are answered, and notifications pass through
 * except for history a session/load replays.
 * @param {OpencodeState} state
 * @param {any} message
 * @returns {object | null}
 */
function normalizeEvent(state, message) {
  if (message.method && message.id != null) return answerRequest(state, message);

  if (message.id != null) {
    if (message.id === state.promptId) {
      state.promptId = null;
      return {
        type: 'turn_end',
        result: message.result ?? null,
        error: message.error ?? null,
        sessionId: state.sessionId,
        model: state.model,
        totalCostUsd: state.cost == null ? null : Math.max(0, state.cost - state.turnStartCost),
      };
    }
    const waiting = state.pending.get(message.id);
    if (waiting) {
      state.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? 'request failed'));
      else waiting.resolve(message.result);
    }
    return null;
  }

  if (message.method !== 'session/update') return null;
  const update = message.params?.update ?? {};
  if (update.sessionUpdate === 'usage_update' && typeof update.cost?.amount === 'number') state.cost = update.cost.amount;
  if (update.sessionUpdate === 'config_option_update') readConfigOptions(state, update.configOptions);
  if (update.sessionUpdate === 'tool_call' && !state.replaying && update.toolCallId && update.title) {
    state.toolNames.set(update.toolCallId, update.title);
  }
  if (state.replaying && TURN_UPDATES.has(update.sessionUpdate)) return null;
  return message;
}

/**
 * Flattens a tool call's ACP content (a list of { type: 'content', content:
 * ContentBlock } and diff entries) to display text.
 * @param {unknown} content
 * @returns {string}
 */
function toolContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      if (entry?.type === 'content') return entry.content?.type === 'text' ? entry.content.text : `[${entry.content?.type ?? 'unknown'}]`;
      if (entry?.type === 'diff') return `${entry.path}\n${entry.newText ?? ''}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
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
 * A short "what's happening now" label for a tool call, like Claude's
 * describeToolUse.
 * @param {string} name
 * @param {{ kind?: string, title?: string, rawInput?: Record<string, unknown>, locations?: { path: string }[] }} update
 * @returns {string}
 */
function describeToolCall(name, update) {
  const input = update.rawInput ?? {};
  const path = input.filePath ?? input.path ?? update.locations?.[0]?.path;
  const file = typeof path === 'string' && path ? basename(path) : 'a file';
  switch (update.kind) {
    case 'execute':
      return `Running: ${input.description || input.command || '…'}`;
    case 'read':
      return `Reading ${file}`;
    case 'edit':
      return `${name === 'write' ? 'Writing' : 'Editing'} ${file}`;
    case 'search':
      return `Searching for "${input.pattern ?? input.query ?? ''}"`;
    case 'fetch':
      return `Fetching ${input.url ?? 'a page'}`;
    default:
      return `Using ${name}`;
  }
}

/**
 * Accumulates one turn from the session/update notifications and
 * synthetic events normalizeEvent passes through.
 * @param {{ onChunk?: (text: string) => void, onStatus?: (status: string) => void }} [callbacks]
 * @returns {TurnAccumulator}
 */
export function createTurnAccumulator({ onChunk, onStatus } = {}) {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {Map<string, string>} */
  const labels = new Map();

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
      if (event.type === 'permission_denied') {
        turn.permissionDenials.push(event.denial);
        return;
      }
      if (event.type === 'turn_end') {
        if (event.sessionId) turn.sessionId = event.sessionId;
        if (event.model) turn.model = event.model;
        turn.totalCostUsd = event.totalCostUsd;
        const usage = event.result?.usage;
        if (usage) {
          turn.usage = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheCreationInputTokens: usage.cachedWriteTokens ?? 0,
            cacheReadInputTokens: usage.cachedReadTokens ?? 0,
          };
        }
        turn.resultText = turn.fullText;
        // Confirmed live: when a rejected permission stops the model,
        // opencode can answer the prompt with an error ("Internal error:
        // The user rejected permission…") instead of a normal stopReason.
        // The denial already says why the turn stopped, and it has to reach
        // the user as a permission card, not as a failed turn.
        if (event.error && !turn.permissionDenials.length) turn.errorMessage = event.error.message ?? 'unknown error';
        else if (event.result?.stopReason === 'refusal') turn.errorMessage = 'the model refused to continue';
        turn.done = true;
        return;
      }

      const update = event.params?.update;
      if (!update) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text' && update.content.text) {
            turn.fullText += update.content.text;
            onChunk?.(update.content.text);
          }
          break;
        case 'tool_call':
        case 'tool_call_update': {
          const id = update.toolCallId;
          if (!id) break;
          if (!names.has(id)) names.set(id, update.title || TOOL_NAME_BY_KIND[update.kind] || 'tool');
          const name = names.get(id);
          const call = turn.toolCalls.get(id) ?? { id, name, label: `Using ${name}`, result: '', isError: false };
          if (update.rawInput && Object.keys(update.rawInput).length) {
            const label = describeToolCall(name, update);
            if (label !== labels.get(id)) {
              labels.set(id, label);
              call.label = label;
              onStatus?.(label);
            }
          }
          if (update.status === 'completed' || update.status === 'failed') {
            const text = toolContentText(update.content) || update.rawOutput?.output || update.rawOutput?.error || '';
            call.result = truncateToolResult(String(text));
            call.isError = update.status === 'failed';
          }
          turn.toolCalls.set(id, call);
          break;
        }
        case 'usage_update':
          if (typeof update.used === 'number') turn.contextTokens = update.used;
          break;
        default:
          break;
      }
    },
  };
  return turn;
}

/**
 * @param {any} event
 * @returns {ProcessSignal}
 */
function inspectEvent(event) {
  // opencode never runs a turn on its own, so nothing outside an explicit
  // turn counts as turn content: anything late (an update racing a stop,
  // say) is dropped instead of opening a background stream that never ends.
  /** @type {ProcessSignal} */
  const signal = { isTurnContent: false };
  const update = event.params?.update;
  if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
    signal.skills = update.availableCommands.map((command) => command.name).filter(Boolean);
  }
  return signal;
}

/**
 * What granting a denied call stores: the containing directory for a path
 * (see decidePermission), else this provider's patterns for a command, else
 * the bare tool name.
 * @param {string} toolName
 * @param {string} value
 * @returns {import('./index.js').PermissionGrant}
 */
function grantFor(toolName, value) {
  if (toolName !== SHELL_TOOL && isAbsolute(value)) return { path: dirname(value) };
  if (toolName === SHELL_TOOL) return { patterns: deriveToolPatterns(toolName, value) };
  return { patterns: [toolName] };
}

/** @type {import('./index.js').AgentProvider} */
export const opencodeProvider = {
  id: 'opencode',
  displayName: 'opencode',
  spawnCommand: (agent) => ({ command: resolveBin(agent.workingDir), args: ['acp', '--cwd', agent.workingDir] }),
  versionCommand: (agent) => {
    const { command, source } = locateBin(agent?.workingDir);
    return { command, args: ['--version'], source };
  },
  startTurn,
  parseLine,
  createProcessState,
  normalizeEvent,
  inspectEvent,
  createTurnAccumulator,
  looksLikeAuthFailure: () => false,
  // opencode's own project command directory, both spellings it accepts.
  commandDirs: ['.opencode/command', '.opencode/commands'],
  builtinCommands: new Set(),
  grantFor,
  overlappingPatterns: (toolName, value) => (toolName === SHELL_TOOL ? deriveToolPatterns(toolName, value) : null),
};
