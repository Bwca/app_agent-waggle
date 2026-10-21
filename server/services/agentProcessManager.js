/**
 * @fileoverview Owns one persistent agent CLI process per agent, kept
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
 *
 * Which CLI that process is, and everything specific to it (flags, wire
 * format, event parsing), comes from the agent's provider — see
 * providers/index.js. This file only owns the lifecycle around it.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';
import { providerForAgent } from './providers/index.js';

/** @typedef {import('./providers/index.js').ToolCall} ToolCall */
/** @typedef {import('./providers/index.js').TurnUsage} TurnUsage */
/** @typedef {import('./providers/index.js').TurnAccumulator} TurnAccumulator */
/** @typedef {import('./providers/index.js').BackgroundTask} BackgroundTask */
/** @typedef {import('./providers/index.js').ProcessSignal} ProcessSignal */

const log = logger.child({ component: 'agentProcessManager' });

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
 * @property {import('./providers/index.js').AgentProvider} provider - The
 *   CLI this process runs as.
 * @property {object} providerState - The provider's own per-process state
 *   (see AgentProvider.createProcessState), passed to normalizeEvent.
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
 * @property {Promise<void> | null} retiring - Set once killAgent has been
 *   called on this process, resolving when it has actually exited. A
 *   retiring process takes no new turns — see isAvailable.
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
 * @param {ManagedProcess} proc
 * @returns {boolean}
 */
function isAlive(proc) {
  return proc.child.exitCode === null && proc.child.signalCode === null;
}

/**
 * Whether a process can take a new turn: alive, and not on its way out.
 * Killing isn't instant — a `claude` process takes ~0.5s to exit after
 * SIGTERM — and killAgent's callers often don't wait for it (removing an
 * agent from a chat responds straight away). Reported via a failing E2E
 * test: an agent moved from one chat to another had its first turn in the
 * new chat written to the old chat's still-exiting process, which then
 * died mid-turn ("exited with code 143"). Had it answered first, it would
 * have answered with the old chat's session, since it was spawned with
 * that chat's --resume.
 * @param {ManagedProcess} proc
 * @returns {boolean}
 */
function isAvailable(proc) {
  return isAlive(proc) && !proc.retiring;
}

/**
 * Registers the handler to call whenever this agent's persistent process
 * produces a full turn's worth of output WITHOUT Agentwaggle having written a
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
 * Applies a process's newly reported background task list — see
 * onBackgroundTasksChanged. Exported for its unit test.
 * @param {ManagedProcess} proc
 * @param {BackgroundTask[]} tasks - The complete current list.
 * @returns {void}
 */
export function applyBackgroundTasksChanged(proc, tasks) {
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
 * Exported so this routing decision — a
 * `result` with is_error:true going to onBackgroundError, never
 * onBackgroundTurn — has a direct unit test; see
 * tests/unit/background-unprompted-error.test.js. Otherwise only ever
 * called from spawnProcess's own stdout handler against a real process.
 * @param {ManagedProcess} proc
 * @param {{ type: string, [key: string]: unknown }} event
 * @param {ProcessSignal} [signal] - The provider's reading of `event`, if
 *   the caller already has it.
 * @returns {void}
 */
export function handleUnsolicitedEvent(proc, event, signal = proc.provider.inspectEvent(event)) {
  if (signal.compaction) {
    // Reported immediately, independent of the turn accumulator below — a
    // compaction firing while idle isn't guaranteed to be followed by any
    // actual agent speech (see onBackgroundCompaction's docs), so it can't
    // wait on `done` the way handler() below does.
    backgroundCompactionHandlers.get(proc.agentId)?.(signal.compaction);
    return;
  }
  if (!signal.isTurnContent) return;

  if (!proc.background) {
    const stream = backgroundStreamHandlers.get(proc.agentId)?.() ?? null;
    proc.backgroundStream = stream;
    proc.background = proc.provider.createTurnAccumulator({ onChunk: stream?.onChunk, onStatus: stream?.onStatus });
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
 * The context-compaction window from Settings, for agents with no override
 * of their own (see Agent.autocompactOverride). Held here rather than read
 * from the database on every spawn, since this module never touches the
 * database itself: index.js sets it at startup, and PUT /api/settings
 * whenever it changes.
 * @type {string | null}
 */
let autocompactDefault = null;

/**
 * Sets the compaction window new processes get when their agent has no
 * override of its own. Only affects processes spawned from now on — a
 * running one keeps the window it started with until it's killed.
 * @param {string | null} value - Already normalized, or null for the provider's own fallback
 * @returns {void}
 */
export function setAutocompactDefault(value) {
  autocompactDefault = value || null;
}

/**
 * Spawns a fresh persistent process for an agent and registers it. Does
 * NOT write anything to stdin — callers decide when a turn actually starts.
 * @param {import('../store/db.js').Agent} agent
 * @returns {ManagedProcess}
 */
function spawnProcess(agent) {
  const resumed = !!agent.resumeId;
  const provider = providerForAgent(agent);
  const { command, args } = provider.spawnCommand(agent, { autocompactDefault });
  const child = spawn(command, args, {
    cwd: agent.workingDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, resumed, provider: provider.id }, 'agent process spawned');

  // Avoid an unhandled EPIPE if the process exits before/while we write.
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (data) => {
    log.warn({ agentId: agent.id, agentName: agent.name, pid: child.pid, stderr: data.trim() }, 'agent process stderr');
  });

  /** @type {ManagedProcess} */
  const proc = { child, agentId: agent.id, provider, providerState: null, buffer: '', currentTurn: null, retiring: null, background: null, backgroundStream: null, backgroundTasks: [], queue: Promise.resolve(), skills: lastKnownSkills.get(agent.id) ?? [] };

  proc.providerState = provider.createProcessState(agent, { write: (data) => child.stdin.write(data) });

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    proc.buffer += chunk;
    const lines = proc.buffer.split('\n');
    proc.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = provider.parseLine(line);
      if (!parsed) continue;
      const event = provider.normalizeEvent(proc.providerState, parsed);
      if (!event) continue;
      const signal = provider.inspectEvent(event);
      // The one piece of information that would have made the Windows MCP
      // investigation trivial instead of requiring hours of empirical
      // spikes: what MCP servers this process actually saw, and whether
      // they connected — now on the record for every single spawn.
      if (signal.mcpServers) {
        log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, mcpServers: signal.mcpServers }, 'mcp server status at turn start');
      }
      if (signal.skills) {
        proc.skills = signal.skills;
        lastKnownSkills.set(agent.id, signal.skills);
      }
      if (signal.backgroundTasks) {
        applyBackgroundTasksChanged(proc, signal.backgroundTasks);
      }
      if (proc.currentTurn) {
        proc.currentTurn.handleEvent(event);
      } else {
        handleUnsolicitedEvent(proc, event, signal);
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
      const parsed = provider.parseLine(proc.buffer);
      proc.buffer = '';
      const event = parsed && provider.normalizeEvent(proc.providerState, parsed);
      if (event) proc.currentTurn?.handleEvent(event);
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
    if (proc.backgroundTasks?.length) applyBackgroundTasksChanged(proc, []);
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
    if (existing?.retiring) {
      existing.retiring.then(() => spawnForAgent(agent));
      return;
    }
    if (existing && isAlive(existing)) return;
    if (!existsSync(agent.workingDir)) return;
    spawnProcess(agent);
  } catch (err) {
    log.error({ agentId: agent.id, agentName: agent.name, err }, 'eager spawn failed');
  }
}

/**
 * A turn's content, or a function that builds it. A function is called only
 * once the turn actually starts — after every turn queued ahead of it on
 * this agent's process has finished — so what it sends can reflect those
 * turns (see ws/handler.js's runAgentsParallel for why that matters).
 * @typedef {import('./agentRunner.js').ContentBlock[] | (() => import('./agentRunner.js').ContentBlock[])} TurnContent
 */

/**
 * Runs one turn against an existing (or freshly spawned) persistent
 * process, queued so it never overlaps another in-flight turn on the same
 * process's stdin. Mirrors the return shape the old one-shot
 * runAgentStream always returned.
 * @param {import('../store/db.js').Agent} agent
 * @param {TurnContent} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[], wasLocalCommand: boolean, contextCleared: boolean, usage: TurnUsage | null, contextTokens: number | null, totalCostUsd: number | null, durationMs: number | null, model: string | null, compactions: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[] }>}
 */
export function runTurn(agent, content, { onChunk, onStatus, signal }) {
  if (!existsSync(agent.workingDir)) {
    return Promise.reject(new Error(t('errors.workingDirMissing', { name: agent.name, path: agent.workingDir })));
  }

  let proc = processes.get(agent.id);
  // Wait for a retiring process to exit, then start over against a fresh
  // spawn — never queue onto it (see isAvailable).
  if (proc?.retiring) {
    return proc.retiring.then(() => runTurn(agent, content, { onChunk, onStatus, signal }));
  }
  if (!proc || !isAvailable(proc)) {
    proc = spawnProcess(agent);
  }

  const turnPromise = proc.queue.then(() => {
    // The process can die while this turn waits behind another (a stop, a
    // kill, a crash). Its exit has already fired by then, so a turn started
    // on it would wait forever for an exit or a reply. Found via a hanging
    // E2E reset: killAll waits for a retiring process's queued turns, and
    // a turn stuck this way stalled it, and with it every later test.
    if (!isAlive(proc)) {
      const code = proc.child.exitCode ?? proc.child.signalCode;
      throw new Error(t('errors.agentExitCode', { provider: proc.provider.displayName, code }));
    }
    return runOneTurn(proc, content, { onChunk, onStatus, signal });
  });
  // Keep the queue chain alive regardless of this turn's outcome, so one
  // failed/rejected turn doesn't wedge every turn queued behind it.
  proc.queue = turnPromise.then(() => {}, () => {});
  return turnPromise;
}

/**
 * @param {ManagedProcess} proc
 * @param {TurnContent} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[], wasLocalCommand: boolean, contextCleared: boolean, usage: TurnUsage | null, contextTokens: number | null, totalCostUsd: number | null, durationMs: number | null, model: string | null, compactions: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[] }>}
 */
function runOneTurn(proc, content, { onChunk, onStatus, signal }) {
  return new Promise((resolve, reject) => {
    // Built first, before this turn claims the process: if building throws,
    // the turn just rejects, with nothing to unwind.
    const blocks = typeof content === 'function' ? content() : content;
    const { provider } = proc;
    const turn = provider.createTurnAccumulator({ onChunk, onStatus });
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
        if (!turn.done) return;
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
          fail(t('errors.agentExecutionError', { provider: provider.displayName, message: turn.errorMessage }));
          return;
        }
        if (provider.looksLikeAuthFailure(turn.resultText)) {
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
          reject(new Error(t('errors.agentExitCode', { provider: provider.displayName, code })));
          return;
        }
        finish();
      },
    };

    // A handshake the provider still has to do first can fail; that fails
    // this turn like any other error, rather than leaving it waiting forever.
    Promise.resolve()
      .then(() => provider.startTurn(proc.providerState, blocks))
      .catch((err) => fail(t('errors.agentExecutionError', { provider: provider.displayName, message: err.message })));
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
  if (proc.retiring) {
    // Already on its way out; an immediate kill (stop, shutdown) still
    // shouldn't wait for a turn that a graceful kill is waiting out.
    if (immediate && isAlive(proc)) killTree(proc.child, 'SIGTERM', agentId);
    return proc.retiring;
  }

  // Kills this specific process, not whatever the registry holds by then:
  // once it's retiring, any newer process for this agent was spawned after
  // the kill was asked for, with current flags and session, so there's
  // nothing about it to undo. If this one already exited on its own while
  // waiting, there's nothing to do.
  const sendKill = () => {
    if (!isAlive(proc)) return Promise.resolve();
    return new Promise((resolve) => {
      proc.child.once('exit', () => resolve());
      killTree(proc.child, 'SIGTERM', agentId);
    });
  };

  // The exit handler already unregisters it; this just guarantees it, since
  // runTurn/spawnForAgent wait on `retiring` and then look again.
  const unregister = () => { if (processes.get(agentId) === proc) processes.delete(agentId); };
  proc.retiring = (immediate ? sendKill() : proc.queue.then(sendKill, sendKill)).then(unregister);
  return proc.retiring;
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
