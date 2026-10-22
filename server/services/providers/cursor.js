/**
 * @fileoverview Cursor as an agent provider (see index.js for the
 * contract): a persistent `cursor-agent acp` process, spoken to over the
 * Agent Client Protocol — newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * Self-contained on purpose, not sharing opencode.js's ACP code: each CLI
 * changes on its own schedule.
 *
 * Confirmed against cursor-agent 2026.10.19 (not assumed from the ACP spec
 * alone):
 * - `initialize`, then `authenticate` with the `cursor_login` method (the
 *   login `cursor-agent login` stored), then `session/new` or
 *   `session/load`, all before the first prompt, so the handshake runs
 *   inside the first turn's startTurn.
 * - `session/load` replays the session as session/update notifications
 *   (tool call ids like "replay-0-2") before it answers; they're dropped.
 *   A session whose turns never reached a model isn't saved at all, and
 *   loading it fails with "Session … not found"; a new session replaces it.
 * - A turn is a `session/prompt` request: text streams as
 *   agent_message_chunk updates, tools as tool_call/tool_call_update (named
 *   by kind only — the title is a description like "`echo hi`"), and the
 *   turn ends with the request's own response ({ stopReason }). No usage
 *   or cost is reported.
 * - Permission prompts arrive mid-turn as `session/request_permission`
 *   (the first with JSON-RPC id 0), answered from the agent's stored grants
 *   (see decidePermission). The request's tool call has no rawInput: the
 *   command or path is only on the tool_call update that came before it. A rejected call is still reported "completed",
 *   with no output, and the model ends its turn normally.
 * - A model the account's plan doesn't allow (a free plan only allows
 *   Auto) isn't an error: the whole reply is "Upgrade your plan to
 *   continue" and the turn ends normally, so it's turned into an error here.
 * - `session/set_config_option` with configId "model" switches the model,
 *   but only to a value exactly as the session lists it
 *   ("grok-4.7[context=256k,…]"); see resolveModelValue. It also becomes
 *   Cursor's saved default model for the user's own `cursor-agent` use.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, delimiter, dirname, join, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { commandPrefixes } from './shellCommands.js';

/** @typedef {import('./index.js').TurnAccumulator} TurnAccumulator */
/** @typedef {import('./index.js').ProcessSignal} ProcessSignal */
/** @typedef {import('../agentRunner.js').PermissionDenial} PermissionDenial */

/** The ACP protocol version this client speaks. */
const PROTOCOL_VERSION = 1;

/** The authenticate method Cursor offers for a stored `cursor-agent login`. */
const AUTH_METHOD = 'cursor_login';

/** The shell tool's name, as Cursor's own permission rules call it. */
const SHELL_TOOL = 'Shell';

/**
 * Tool kinds (ACP's ToolKind) whose call acts on a file path, which a
 * directory grant (extraAllowedPaths) can authorize, the counterpart of
 * Claude's FILE_PATH_TOOLS.
 */
const FILE_KINDS = new Set(['read', 'edit', 'delete', 'move']);

/** A tool's name by ACP ToolKind, since Cursor's tool calls don't name one. */
const TOOL_NAME_BY_KIND = { execute: SHELL_TOOL, edit: 'Edit', read: 'Read', delete: 'Delete', move: 'Move', search: 'Grep', fetch: 'Fetch' };

/** Same cap and reasoning as providers/claude.js's MAX_TOOL_RESULT_CHARS. */
const MAX_TOOL_RESULT_CHARS = 8000;

/** The model value meaning Cursor's own Auto choice. */
const AUTO_MODEL = 'default[]';

/**
 * A reply that's really Cursor refusing the model: the account's plan
 * doesn't allow it. Confirmed live as a whole agent_message_chunk ending
 * with stopReason end_turn, not as an error.
 */
const PLAN_LIMIT_REPLY = /^upgrade your plan to continue\.?$/i;

/**
 * Where Cursor's install script puts the binary. Often not on the PATH the
 * server inherits, so it's checked by path rather than left to PATH.
 */
const HOME_INSTALL_BIN = join(homedir(), '.local', 'bin', 'cursor-agent');

/** The script that prints the models a Cursor session offers (modelsCommand). */
const MODELS_SCRIPT = fileURLToPath(new URL('./cursorModels.js', import.meta.url));

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
 * The cursor-agent binary, and where it was found, first match wins:
 * CURSOR_AGENT_BIN; `cursor-agent` on PATH; Cursor's own install location
 * (HOME_INSTALL_BIN). With none of them, plain `cursor-agent`, which then
 * fails to spawn with a clear ENOENT. Not the `agent` alias the installer
 * also adds: too generic a name to trust on PATH.
 * @returns {{ command: string, source: import('./index.js').BinarySource }}
 */
export function locateBin() {
  if (process.env.CURSOR_AGENT_BIN) return { command: process.env.CURSOR_AGENT_BIN, source: 'env' };
  const onPath = findOnPath('cursor-agent');
  if (onPath) return { command: onPath, source: 'path' };
  if (existsSync(HOME_INSTALL_BIN)) return { command: HOME_INSTALL_BIN, source: 'home' };
  return { command: 'cursor-agent', source: 'path' };
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
 * A JSON-RPC error's most specific text: Cursor puts the useful part
 * ("Session … not found") in `data`, under a generic "Invalid params" or
 * "Internal error" message.
 * @param {{ message?: string, data?: { message?: string, details?: string } }} error
 * @returns {string}
 */
export function rpcErrorText(error) {
  return error?.data?.message ?? error?.data?.details ?? error?.message ?? 'request failed';
}

/**
 * @typedef {Object} CursorState
 * @property {import('../../store/db.js').Agent} agent - As it was at spawn;
 *   anything that changes how a process should behave respawns it.
 * @property {(data: string) => void} write
 * @property {number} nextId
 * @property {Map<number, { resolve: (result: any) => void, reject: (err: Error) => void }>} pending -
 *   This client's own requests still waiting on a response.
 * @property {Promise<void> | null} ready - The handshake, once started.
 * @property {boolean} replaying - True while session/load replays history.
 * @property {string | null} sessionId
 * @property {string | null} model - The session's current model value.
 * @property {string[]} modelValues - Every model value the session offers.
 * @property {number | null} promptId - The in-flight session/prompt request.
 * @property {Map<string, Record<string, unknown>>} toolInputs - rawInput per
 *   toolCallId, for the permission request that follows (see describeRequest).
 */

/**
 * @param {import('../../store/db.js').Agent} agent
 * @param {{ write: (data: string) => void }} io
 * @returns {CursorState}
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
    modelValues: [],
    promptId: null,
    toolInputs: new Map(),
  };
}

/**
 * @param {CursorState} state
 * @param {object} message
 */
function send(state, message) {
  state.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

/**
 * Sends a request and resolves with its result, or rejects with its error.
 * @param {CursorState} state
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
 * Reads the session's model, and the models it offers, off the config
 * options a session/new, session/load or set_config_option response (or a
 * config_option_update) reports.
 * @param {CursorState} state
 * @param {unknown} configOptions
 */
function readConfigOptions(state, configOptions) {
  if (!Array.isArray(configOptions)) return;
  const model = configOptions.find((option) => option?.id === 'model');
  if (typeof model?.currentValue === 'string') state.model = model.currentValue;
  if (Array.isArray(model?.options)) state.modelValues = model.options.map((option) => option?.value).filter((value) => typeof value === 'string');
}

/**
 * The value set_config_option needs for a model override. Cursor only takes
 * a value exactly as the session lists it, settings and all
 * ("grok-4.7[context=256k,reasoning_effort=high,fast=true]"), so a bare
 * model name ("grok-4.7", as the model picker offers) matches the listed
 * value it starts, and "auto" is Cursor's Auto. Anything else is passed as
 * given, for Cursor to reject.
 * @param {string} override
 * @param {string[]} values
 * @returns {string}
 */
export function resolveModelValue(override, values) {
  if (values.includes(override)) return override;
  if (override.toLowerCase() === 'auto') return AUTO_MODEL;
  return values.find((value) => value.split('[')[0] === override) ?? override;
}

/**
 * Opens (or resumes) the agent's session and applies its model override.
 * @param {CursorState} state
 * @returns {Promise<void>}
 */
async function handshake(state) {
  const { agent } = state;
  await request(state, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    // Nothing offered: Cursor reads and writes files and runs commands
    // itself, in the agent's working directory.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  try {
    await request(state, 'authenticate', { methodId: AUTH_METHOD });
  } catch (err) {
    throw new Error(`Cursor login failed (${err.message}); run \`cursor-agent login\``);
  }
  let session = null;
  if (state.sessionId) {
    state.replaying = true;
    try {
      session = await request(state, 'session/load', { sessionId: state.sessionId, cwd: agent.workingDir, mcpServers: [] });
    } catch (err) {
      // Never saved (see the file docs): nothing to lose by starting over.
      if (!/not found/i.test(err.message)) throw err;
    } finally {
      state.replaying = false;
    }
  }
  if (!session) {
    session = await request(state, 'session/new', { cwd: agent.workingDir, mcpServers: [] });
    state.sessionId = session.sessionId;
  }
  readConfigOptions(state, session?.configOptions);
  if (agent.modelOverride) {
    const value = resolveModelValue(agent.modelOverride, state.modelValues);
    if (value !== state.model) {
      const updated = await request(state, 'session/set_config_option', { sessionId: state.sessionId, configId: 'model', value });
      readConfigOptions(state, updated?.configOptions);
    }
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
 * @param {CursorState} state
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
 * A tool call's name: by kind, else its title (an MCP tool's, say), else
 * "tool".
 * @param {{ kind?: string, title?: string }} toolCall
 * @returns {string}
 */
function toolName(toolCall) {
  return TOOL_NAME_BY_KIND[toolCall.kind] ?? toolCall.title ?? 'tool';
}

/**
 * A permission request's tool input: its own rawInput if it ever has one,
 * else the one its tool_call update reported, else a command recovered from
 * an execute call's title ("`date -u`"). Without one, the card would offer
 * to grant the whole tool instead of the command it asked about.
 * @param {CursorState} state
 * @param {{ toolCallId: string, kind?: string, title?: string, rawInput?: Record<string, unknown> }} toolCall
 * @returns {Record<string, unknown>}
 */
function requestInput(state, toolCall) {
  if (toolCall.rawInput && Object.keys(toolCall.rawInput).length) return toolCall.rawInput;
  const reported = state.toolInputs.get(toolCall.toolCallId);
  if (reported) return reported;
  const titled = toolCall.kind === 'execute' && toolCall.title?.match(/^`(.+)`$/s);
  return titled ? { command: titled[1] } : {};
}

/**
 * Describes a permission request's tool call the way a denial records it,
 * so the permission card shows a path or a command like it does for Claude.
 * @param {CursorState} state
 * @param {{ toolCallId: string, kind?: string, title?: string, rawInput?: Record<string, unknown>, locations?: { path: string }[] }} toolCall
 * @returns {PermissionDenial}
 */
function describeRequest(state, toolCall) {
  const input = requestInput(state, toolCall);
  const path = input.path ?? input.filePath ?? toolCall.locations?.[0]?.path;
  let toolInput = input;
  if (typeof input.command === 'string') toolInput = { command: input.command };
  else if (FILE_KINDS.has(toolCall.kind) && typeof path === 'string') toolInput = { file_path: path };
  return { tool_name: toolName(toolCall), tool_use_id: toolCall.toolCallId, tool_input: toolInput };
}

/**
 * Answers a permission request from the agent's stored grants, the way
 * Claude's spawn flags would: everything under YOLO mode; a file tool on a
 * path inside the working directory or a granted directory (Claude's
 * acceptEdits); a command whose every sub-command a granted pattern
 * covers; any other tool granted by name.
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
    const grantedPrefixes = [...granted].flatMap((pattern) => {
      const match = pattern.match(/^(.+?)\((.+):\*\)$/);
      return match && match[1] === call.tool_name ? [match[2]] : [];
    });
    const prefixes = commandPrefixes(command);
    return prefixes.length > 0 && prefixes.every((prefix) => grantedPrefixes.some((grant) => prefix === grant || prefix.startsWith(`${grant} `)));
  }
  return false;
}

/**
 * The patterns granting a command authorizes, one per sub-command, in this
 * provider's own syntax ("Shell(git add:*)"). Only this file reads them back,
 * as prefixes like Claude's Bash patterns: "Shell(date:*)" covers "date -u"
 * too.
 * @param {string} name
 * @param {string} command
 * @returns {string[]}
 */
function deriveToolPatterns(name, command) {
  return commandPrefixes(command).map((prefix) => (prefix ? `${name}(${prefix}:*)` : name));
}

/**
 * Picks the option with the given ACP PermissionOptionKind prefix ("allow"
 * or "reject"), preferring a one-time one: a grant is stored by this app,
 * never by Cursor, so it's the same everywhere the agent runs.
 * @param {{ optionId: string, kind: string }[]} options
 * @param {'allow' | 'reject'} kind
 * @returns {string | undefined}
 */
function pickOption(options, kind) {
  return (options.find((o) => o.kind === `${kind}_once`) ?? options.find((o) => o.kind?.startsWith(kind)))?.optionId;
}

/**
 * Handles a request Cursor sends this client. A permission request is
 * answered here and, if rejected, becomes a `permission_denied` event for
 * the turn; anything else is refused, including Cursor's own blocking
 * extensions (cursor/ask_question, cursor/create_plan), which this app has
 * no way to put to the user mid-turn: refusing beats leaving the turn
 * waiting on an answer forever.
 * @param {CursorState} state
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
 * `turn_end` event), requests are answered, session/update notifications
 * pass through except for history a session/load replays, and Cursor's own
 * notifications (cursor/update_todos and the like) are dropped.
 * @param {CursorState} state
 * @param {any} message
 * @returns {object | null}
 */
function normalizeEvent(state, message) {
  // `!= null`, not truthiness: Cursor's first request to this client has id 0.
  if (message.method && message.id != null) return answerRequest(state, message);

  if (message.id != null) {
    if (message.id === state.promptId) {
      state.promptId = null;
      return {
        type: 'turn_end',
        result: message.result ?? null,
        error: message.error ? { message: rpcErrorText(message.error) } : null,
        sessionId: state.sessionId,
        model: state.model,
      };
    }
    const waiting = state.pending.get(message.id);
    if (waiting) {
      state.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(rpcErrorText(message.error)));
      else waiting.resolve(message.result);
    }
    return null;
  }

  if (message.method !== 'session/update') return null;
  const update = message.params?.update ?? {};
  if (update.sessionUpdate === 'config_option_update') readConfigOptions(state, update.configOptions);
  if (update.sessionUpdate === 'tool_call' && !state.replaying && update.toolCallId && update.rawInput) {
    state.toolInputs.set(update.toolCallId, update.rawInput);
  }
  if (update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
    state.toolInputs.delete(update.toolCallId);
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
 * A tool call's output as display text. Cursor reports a command's as
 * { exitCode, stdout, stderr } and a read's as { content } in rawOutput.
 * @param {{ content?: unknown, rawOutput?: Record<string, unknown> }} update
 * @returns {string}
 */
function toolResultText(update) {
  const fromContent = toolContentText(update.content);
  if (fromContent) return fromContent;
  const output = update.rawOutput ?? {};
  if (typeof output.content === 'string') return output.content;
  return [output.stdout, output.stderr].filter((part) => typeof part === 'string' && part).join('\n');
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
 * @param {{ kind?: string, rawInput?: Record<string, unknown>, locations?: { path: string }[] }} update
 * @returns {string}
 */
function describeToolCall(name, update) {
  const input = update.rawInput ?? {};
  const path = input.path ?? input.filePath ?? update.locations?.[0]?.path;
  const file = typeof path === 'string' && path ? basename(path) : 'a file';
  switch (update.kind) {
    case 'execute':
      return `Running: ${input.command || '…'}`;
    case 'read':
      return `Reading ${file}`;
    case 'edit':
      return `Editing ${file}`;
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
        turn.resultText = turn.fullText;
        if (event.error && !turn.permissionDenials.length) turn.errorMessage = event.error.message;
        else if (event.result?.stopReason === 'refusal') turn.errorMessage = 'the model refused to continue';
        else if (!turn.toolCalls.size && PLAN_LIMIT_REPLY.test(turn.fullText.trim())) {
          turn.errorMessage = `Cursor: ${turn.fullText.trim()} (a free plan only allows the Auto model)`;
        }
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
          const call = turn.toolCalls.get(id) ?? { id, name: toolName(update), label: `Using ${toolName(update)}`, result: '', isError: false };
          if (update.rawInput && Object.keys(update.rawInput).length) {
            const label = describeToolCall(call.name, update);
            if (label !== labels.get(id)) {
              labels.set(id, label);
              call.label = label;
              onStatus?.(label);
            }
          }
          if (update.status === 'completed' || update.status === 'failed') {
            // A rejected call is still reported "completed", with no output.
            const denied = turn.permissionDenials.some((denial) => denial.tool_use_id === id);
            call.result = denied ? 'Permission denied' : truncateToolResult(toolResultText(update));
            call.isError = denied || update.status === 'failed';
          }
          turn.toolCalls.set(id, call);
          break;
        }
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
  // Cursor never runs a turn on its own, so nothing outside an explicit
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
 * @param {string} name
 * @param {string} value
 * @returns {import('./index.js').PermissionGrant}
 */
function grantFor(name, value) {
  if (name !== SHELL_TOOL && isAbsolute(value)) return { path: dirname(value) };
  if (name === SHELL_TOOL) return { patterns: deriveToolPatterns(name, value) };
  return { patterns: [name] };
}

/** @type {import('./index.js').AgentProvider} */
export const cursorProvider = {
  id: 'cursor',
  displayName: 'Cursor',
  spawnCommand: () => ({ command: locateBin().command, args: ['acp'] }),
  versionCommand: () => {
    const { command, source } = locateBin();
    return { command, args: ['--version'], source };
  },
  // Not `cursor-agent models`: its ids ("cursor-grok-4.6-medium") aren't
  // ones an ACP session accepts. The script asks a session instead.
  modelsCommand: () => ({ command: process.execPath, args: [MODELS_SCRIPT, locateBin().command] }),
  startTurn,
  parseLine,
  createProcessState,
  normalizeEvent,
  inspectEvent,
  createTurnAccumulator,
  looksLikeAuthFailure: () => false,
  commandDirs: ['.cursor/commands'],
  builtinCommands: new Set(),
  grantFor,
  overlappingPatterns: (name, value) => (name === SHELL_TOOL ? deriveToolPatterns(name, value) : null),
};
