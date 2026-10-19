/**
 * @fileoverview WebSocket connection handler.
 * Receives USER_MESSAGE events and orchestrates agent responses.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { dirname } from 'path';
import { getChat, getAgent, getAgentChatId, getMessages, addMessage, grantAgentPath, grantAgentToolPattern, setAgentResumeIdIfUnset, recordContextClear, setAgentModel, setAgentSeenUntil, setAgentUsage, setAgentSessionLimitReset, getUserDisplayName, createScheduledMessage, getScheduledMessages } from '../store/db.js';
import { parseResponders, extractMentionedAgents, parseSkillInvocation } from '../services/messageRouter.js';
import { runAgentStream, FILE_PATH_TOOLS, deriveToolPatterns, dedupePermissionDenials } from '../services/agentRunner.js';
import { killAgent, onBackgroundTurn, onBackgroundCompaction, onBackgroundError, onBackgroundUsage, onBackgroundStream, onBackgroundTasksChanged, getAllBackgroundTasks } from '../services/agentProcessManager.js';
import { scheduleTimer } from '../services/scheduler.js';
import { parseSessionLimitReset } from '../services/sessionLimitReset.js';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';
import { logTranscript } from '../transcriptLog.js';

const log = logger.child({ component: 'ws:handler' });

/**
 * @typedef {Object} ActiveStream
 * @property {AbortController} controller - consulted by the STOP_AGENT
 *   handler below to interrupt this turn.
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} agentName
 * @property {string} agentColor
 * @property {number} startedAt - epoch ms
 * @property {string} text - accumulated response text so far (mirrors every
 *   AGENT_STREAM_CHUNK broadcast for this stream)
 * @property {string} statusText - last live "what's happening" status line
 *   broadcast for this stream (e.g. "Running: ls", "Delegating: …"), '' if
 *   none has fired yet this turn
 */

/**
 * Live streams that could still be interrupted, keyed by streamId. Populated
 * for the duration of each runAgentStream() call in runAgentsParallel and
 * consulted by the STOP_AGENT handler below — a stream not in this map has
 * already finished (or never existed), so a late/duplicate stop is a no-op.
 *
 * Also doubles as the source of truth for catching a freshly-connected
 * client up on turns already in flight (see handleConnection's snapshot
 * send below) — a browser refresh mid-turn used to show nothing at all
 * until the turn finished and MESSAGE_SAVED arrived, which looked
 * indistinguishable from the agent being stuck or the server having
 * dropped the request. text/statusText are kept in step with every
 * broadcast chunk/status so a newly-connecting client can reconstruct the
 * exact bubble a client that stayed connected would have.
 * @type {Map<string, ActiveStream>}
 */
const activeStreams = new Map();

/**
 * Builds the snapshot of every currently in-flight stream, newest first —
 * sent once to each newly-connected client (see handleConnection) so a page
 * refresh (or first load) mid-turn doesn't look idle. Not broadcast to
 * existing clients: they've already been receiving the real-time
 * START/CHUNK/STATUS events for these streams and reconstructing this from
 * the snapshot would just redundantly recreate bubbles they already have.
 * @returns {Array<{type: 'AGENT_STREAM_SNAPSHOT', streamId: string, chatId: string, agentId: string, agentName: string, agentColor: string, startedAt: number, text: string, statusText: string}>}
 */
function buildActiveStreamSnapshot() {
  return [...activeStreams.entries()].map(([streamId, s]) => ({
    type: 'AGENT_STREAM_SNAPSHOT',
    streamId,
    chatId: s.chatId,
    agentId: s.agentId,
    agentName: s.agentName,
    agentColor: s.agentColor,
    startedAt: s.startedAt,
    text: s.text,
    statusText: s.statusText,
  }));
}

/**
 * History-fetch cap for an observer agent's own turn (see runAgentsParallel),
 * overriding the normal 20-message window every other agent gets. An
 * observer (agent.isObserver) never responds to a broadcast — only to an
 * explicit @mention — so it may sit out for a long stretch of a busy chat's
 * traffic; when it's finally asked to summarize, it needs to see all of
 * that, not just the last 20 messages. 1000 is generous headroom over a
 * realistic "whole busy day" for this app's usage, not a literal unlimited
 * fetch — getMessages has no "no limit" mode, and an unbounded SELECT would
 * risk a huge prompt/cost spike on a pathologically long-lived chat.
 */
const OBSERVER_HISTORY_LIMIT = 1000;

/**
 * Safety ceiling on relay rounds in a chat.freeRelay chat (see
 * handleUserMessage's relay loop) — a bounded chat never needs this, it
 * stops after exactly one round regardless. Free relay deliberately allows
 * the same agent to be re-triggered round after round (an extended
 * back-and-forth is the whole point), which means nothing else naturally
 * stops a two-agent mutual-@mention exchange from continuing indefinitely.
 * 20 is generous headroom for a real multi-turn discussion while still
 * bounding worst-case cost/time if two agents just keep re-mentioning each
 * other with nothing new to say.
 */
const FREE_RELAY_MAX_ROUNDS = 20;

/**
 * @typedef {Object} PendingTurn
 * @property {{ message: NewUserMessage, excludeMessageId: string }} trigger -
 *   What the turn will answer; replaced by each trigger folded into it.
 * @property {string[]} foldedMessageIds - Every earlier trigger, which the
 *   turn still has to show the agent.
 * @property {Promise<import('../store/db.js').Message | null>} reply
 */

/**
 * Turns queued for a busy agent but not yet started, at most one per agent
 * per chat (keyed `${chatId}:${agentId}`). A new trigger for that agent
 * joins the waiting turn instead of queueing another — see
 * runAgentsParallel's `coalesce` option.
 * @type {Map<string, PendingTurn>}
 */
const pendingTurns = new Map();

/**
 * @typedef {Object} ShownTurn
 * @property {Set<string>} messageIds - Every chat message in the turn's
 *   prompt window when it was built, its trigger included.
 * @property {Promise<import('../store/db.js').Message | null>} reply
 * @property {boolean} done - The turn ran to completion.
 */

/**
 * The latest turn per agent per chat (keyed like pendingTurns) whose prompt
 * has been built, kept while it runs and after it completes. A trigger the
 * agent was already shown there gets no turn of its own: a relay fires only
 * once the whole round it came from has finished, which can be after the
 * mentioned agent already read the mention as catch-up in a turn that
 * started meanwhile. Reported live: four agents woken by one reset each
 * got every teammate's @mention again a few seconds after reading it, and
 * spent a dozen turns posting "crossed in flight, nothing new".
 * @type {Map<string, ShownTurn>}
 */
const shownTurns = new Map();

/**
 * Reply messages a chain has already relayed, so a reply shared by several
 * chains (see pendingTurns) relays once, not once per chain. Those chains
 * usually reach the relay together, and the second relay folds into the
 * teammate's still-waiting turn anyway; this covers the case where the
 * teammate's turn has already started by then.
 * Bounded: only recent replies can still be in flight.
 * @type {Set<string>}
 */
const relayScannedMessageIds = new Set();
const RELAY_SCANNED_LIMIT = 1000;

/**
 * Marks replies as relayed — see relayScannedMessageIds.
 * @param {Iterable<string>} messageIds
 * @returns {void}
 */
function markRelayed(messageIds) {
  for (const id of messageIds) relayScannedMessageIds.add(id);
  while (relayScannedMessageIds.size > RELAY_SCANNED_LIMIT) {
    relayScannedMessageIds.delete(relayScannedMessageIds.values().next().value);
  }
}

/**
 * @typedef {Object} UserMessageEvent
 * @property {'USER_MESSAGE'} type
 * @property {string} chatId
 * @property {string} content
 * @property {import('../store/db.js').Attachment[]} [attachments]
 * @property {string} [asAgentId] - Post as this agent (a member of the
 *   chat) instead of as the user. Only the MCP `send_message` tool sets it,
 *   for an agent posting into its own chat — see handleUserMessage.
 */

/**
 * @typedef {Object} NewUserMessage
 * @property {string} content
 * @property {import('../store/db.js').Attachment[]} attachments
 * @property {Pick<import('../store/db.js').Message, 'role' | 'agentId' | 'authorName'>} [from] -
 *   Who posted it, when it's a saved chat message (the user, or a teammate
 *   whose reply is being relayed). Shown to the agent ahead of the content,
 *   via authorLabel — see buildPromptBlocks. Left unset
 *   for content that must reach the CLI exactly as given (a skill command)
 *   or that no one in the chat wrote (a permission continuation).
 */

/**
 * @typedef {Object} MessageSavedEvent
 * @property {'MESSAGE_SAVED'} type
 * @property {string} chatId
 * @property {import('../store/db.js').Message} message
 */

/**
 * @typedef {Object} AgentStreamStartEvent
 * @property {'AGENT_STREAM_START'} type
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} streamId
 * @property {string} agentName
 * @property {string} agentColor
 */

/**
 * @typedef {Object} AgentStreamChunkEvent
 * @property {'AGENT_STREAM_CHUNK'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} text
 */

/**
 * @typedef {Object} AgentStreamStatusEvent
 * @property {'AGENT_STREAM_STATUS'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} status - Short human label, e.g. "Reading app.js"
 */

/**
 * @typedef {Object} AgentStreamEndEvent
 * @property {'AGENT_STREAM_END'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} fullText
 * @property {import('../store/db.js').Message} message - The persisted message,
 *   including its toolCalls (see agentProcessManager.js's ToolCall typedef).
 * @property {import('../services/agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {boolean} stopped - True if the user interrupted this turn via
 *   STOP_AGENT rather than it finishing on its own.
 */

/**
 * @typedef {Object} AgentStreamErrorEvent
 * @property {'AGENT_STREAM_ERROR'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} error
 */

/**
 * An agent's persistent process resumed and finished a turn entirely on its
 * own initiative — no user message triggered it. Its live progress was
 * streamed via the usual AGENT_STREAM_START/CHUNK/STATUS events under
 * `streamId` (see makeBackgroundStreamFactory); this replaces that bubble
 * with the persisted message. See
 * agentProcessManager.js's onBackgroundTurn for the mechanism (a backgrounded
 * Bash task finishing is the common case) and makeBackgroundTurnHandler for
 * where this gets built and broadcast.
 * @typedef {Object} AgentBackgroundMessageEvent
 * @property {'AGENT_BACKGROUND_MESSAGE'} type
 * @property {string} chatId
 * @property {string} agentId
 * @property {import('../store/db.js').Message} message
 * @property {import('../services/agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {string | null} streamId - The live stream makeBackgroundStreamFactory
 *   opened for this turn while it ran, which this message replaces; null if
 *   none was opened.
 */

/**
 * An agent's set of still-running background tasks (e.g. a backgrounded
 * Bash command) changed — the complete current list, not a delta; an empty
 * list means it's no longer waiting on anything. See agentProcessManager.js's
 * onBackgroundTasksChanged. Also sent once per busy agent to a
 * newly-connected client (see handleConnection).
 * @typedef {Object} AgentBackgroundTasksEvent
 * @property {'AGENT_BACKGROUND_TASKS'} type
 * @property {string} agentId
 * @property {import('../services/agentProcessManager.js').BackgroundTask[]} tasks
 */

/**
 * A live stream opened for an unsolicited (self-resumed) turn ended without
 * producing a message to replace it with — no content, or the process was
 * stopped/died mid-turn. The client just drops the bubble.
 * @typedef {Object} AgentStreamDiscardEvent
 * @property {'AGENT_STREAM_DISCARD'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 */

/**
 * Synthetic follow-up sent to an agent right after one of its permission
 * denials is granted. The agent's own turn already ended when the denial
 * surfaced — headless mode has no way to retry mid-turn — so without this
 * nudge nothing happens until the user types a brand new message.
 * @type {NewUserMessage}
 */
const CONTINUE_AFTER_GRANT_MESSAGE = {
  content: 'The permission you needed for that last action has just been granted. Please retry it and continue.',
  attachments: [],
};

/**
 * Synthetic follow-up sent to an agent right after one of its permission
 * denials is explicitly denied by the user (as opposed to granted). Same
 * reasoning as CONTINUE_AFTER_GRANT_MESSAGE — the agent's turn already
 * ended, so without this nudge it's just left stuck — but unlike granting,
 * nothing is persisted here: a denial is already the agent's default
 * state, there's no "revoke" to record. Interpolates the specific
 * tool+value denied, since a turn can carry more than one denial row and
 * the user may deny some while granting others.
 * @param {string} toolName
 * @param {string} value
 * @returns {NewUserMessage}
 */
function buildDenyContinueMessage(toolName, value) {
  return {
    content: `Your request to use ${toolName} (${value}) was declined for now. Please continue with whatever else you can do, or ask for guidance — you're welcome to propose it again later if it's still needed.`,
    attachments: [],
  };
}

/**
 * @typedef {Object} PermissionOutcome
 * @property {string} toolName
 * @property {string} value
 * @property {boolean} granted - True if this row was granted, false if denied.
 */

/**
 * Builds the synthetic follow-up sent once every denial row in a permission
 * card has been resolved (granted or denied) — never before. A single turn
 * can surface more than one denial at once (the model tries several blocked
 * actions, or retries one), and the user works through the card's rows one
 * click at a time; nudging the agent to continue after just the FIRST click
 * would race an auto-continued turn against the user still deciding on the
 * rest of the card. The client tracks how many rows remain and only marks
 * the wire event `autoContinue: true` on whichever click resolves the last
 * one — see buildPermissionCard's resolvedCount tracking — so this is only
 * ever called with the complete, final set of outcomes for that card.
 *
 * A single-row card (the common case) keeps the exact prior wording for
 * that one outcome; a multi-row card gets one combined message listing
 * every outcome, so the agent knows what to retry and what to leave alone.
 * @param {PermissionOutcome[]} outcomes
 * @returns {NewUserMessage}
 */
function buildContinueMessage(rawOutcomes) {
  // The client only ever sends this once every row's own slot is filled
  // (see buildPermissionCard's resolvedCount tracking), so this should
  // never actually contain a gap — filtered defensively anyway, since this
  // reads a client-supplied WS message, a trust boundary worth not
  // crashing the server over.
  const outcomes = rawOutcomes.filter((o) => o && typeof o.toolName === 'string' && typeof o.value === 'string');
  if (outcomes.length === 0) {
    return { content: 'Please continue.', attachments: [] };
  }
  if (outcomes.length === 1) {
    const [{ toolName, value, granted }] = outcomes;
    return granted ? CONTINUE_AFTER_GRANT_MESSAGE : buildDenyContinueMessage(toolName, value);
  }
  const lines = outcomes.map((o) => `- ${o.granted ? 'GRANTED' : 'DECLINED'}: ${o.toolName} (${o.value})`);
  return {
    content: [
      `Here's what happened with the ${outcomes.length} actions that needed your approval:`,
      ...lines,
      ``,
      `For anything GRANTED, go ahead and retry it now. For anything DECLINED, don't retry it — continue with whatever else you can do, or ask for guidance if you're blocked; you're welcome to propose a declined action again later if it's still needed.`,
    ].join('\n'),
    attachments: [],
  };
}

/**
 * Tail of each agent's queue of permission resolutions — see
 * withPermissionLock.
 * @type {Map<string, Promise<void>>}
 */
const permissionLocks = new Map();

/**
 * Runs `fn` once every earlier permission resolution for this agent has
 * finished. "Grant all" sends one GRANT_PERMISSION per row in the same
 * tick, and the server handles WS messages concurrently, so without this
 * the row that auto-continues could run between another row's grants.
 * Reported via a flaky E2E test: a chained Bash grant had saved its
 * `git init` pattern but not yet its `git add` one when the Write row's
 * retry spawned the agent's process, so the retry was denied `git add -A`
 * again.
 * @template T
 * @param {string} agentId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPermissionLock(agentId, fn) {
  const run = (permissionLocks.get(agentId) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  permissionLocks.set(agentId, tail);
  tail.then(() => { if (permissionLocks.get(agentId) === tail) permissionLocks.delete(agentId); });
  return run;
}

/**
 * Broadcasts a JSON payload to all connected WebSocket clients.
 * @param {WebSocketServer} wss
 * @param {object} payload
 */
export function broadcast(wss, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Renders a short placeholder for an attachment, used when summarizing older
 * messages in the history section (their full content isn't resent every turn).
 * @param {import('../store/db.js').Attachment} att
 * @returns {string}
 */
function summarizeAttachment(att) {
  return att.type === 'image'
    ? `[image: ${att.name ?? 'pasted'}]`
    : `[pasted text: ${att.name ?? 'untitled'}, ${att.data.length} chars]`;
}

/**
 * How an agent is named wherever it has to be told apart from another
 * agent with the same name: its name plus its id. Shared by message labels
 * (authorLabel), the roster (formatRoster) and the roster-change notes
 * (postAgentAddedNote/postAgentRemovedNote), so all of them read alike.
 * @param {{ name: string, id: string }} agent
 * @returns {string}
 */
function agentRef(agent) {
  return `${agent.name} [agent ${agent.id}]`;
}

/**
 * How a message's author is named to an agent, in catch-up lines and in a
 * turn's own triggering message alike. A name alone isn't enough: two
 * agents can share one, and the user's display name can be anything, a
 * teammate's name included. So it says whether the author is the user or an
 * agent, and which agent by id (the same id the roster gives — see
 * formatRoster).
 * @param {Pick<import('../store/db.js').Message, 'role' | 'agentId' | 'authorName'>} m
 * @returns {string}
 */
function authorLabel(m) {
  if (m.role === 'user') return `${m.authorName} [user]`;
  return m.agentId ? agentRef({ name: m.authorName, id: m.agentId }) : m.authorName;
}

/**
 * Renders one history line, appending attachment placeholders (not full content).
 * @param {import('../store/db.js').Message} m
 * @returns {string}
 */
function renderHistoryLine(m) {
  const summary = (m.attachments ?? []).map(summarizeAttachment).join(' ');
  return `${authorLabel(m)}: ${[m.content, summary].filter(Boolean).join(' ')}`;
}

/**
 * Narrows a raw message window down to what a given agent actually needs
 * re-sent as context.
 *
 * Each agent is a real, resumed `claude` CLI session (`--resume`) — once it
 * has a resumeId, Claude already natively remembers every turn where THIS
 * agent was the one invoked (its own past prompts and replies), same as any
 * resumed terminal session. Re-sending that history is pure duplication.
 * The only genuinely new information for a resumed agent is messages it
 * was never invoked for at all — a teammate's reply, or a message routed
 * only to someone else — that happened since its own last turn here.
 *
 * An agent with no resumeId yet has zero session memory, so it needs the
 * full window (its very first turn, or it just joined an existing chat).
 *
 * Note this doesn't just trust `resumeId`'s presence blindly for the
 * narrowing itself — it actually searches `messages` for this agent's own
 * last turn (`lastOwnIdx`). That's what makes this safe even for an agent
 * resumed from a resumeId supplied manually at creation, pointing at a
 * session with no relation to this chat at all (see buildPromptBlocks'
 * docs for why that distinction matters): if no own turn is found in this
 * chat's history, `lastOwnIdx` stays -1 and the full window still goes out,
 * exactly as if it had no resumeId.
 *
 * A past "/clear" (agent.contextResetAt — see its docs on the Agent
 * typedef) gets the same "zero memory" treatment: a turn from before the
 * reset doesn't count as a valid `lastOwnIdx` boundary, since the CLI
 * session that actually ran it no longer exists. If this agent hasn't
 * spoken again since clearing, that search comes up empty and the full
 * window goes out, same as a never-resumed agent.
 *
 * When `agent.seenUntil` is known — the moment this agent's last completed
 * turn here had its prompt built — it's the boundary instead of the agent's
 * own last reply. The reply is the wrong boundary for a busy agent: anything
 * posted while its turn was running predates that reply but never reached
 * it, and with the prompt now built when a queued turn starts (see
 * runAgentsParallel) that content would otherwise be skipped. A "/clear"
 * after it voids it the same way it voids a reply boundary.
 *
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Message[]} messages - Chronological (oldest first)
 * @returns {import('../store/db.js').Message[]}
 */
export function catchUpMessagesFor(agent, messages) {
  if (!agent.resumeId) return messages;

  const { seenUntil } = agent;
  // `>=`, not `>`: a message saved in the same millisecond the prompt was
  // built may or may not have made it in. Re-sending it costs a line;
  // dropping it loses it.
  if (seenUntil && (!agent.contextResetAt || seenUntil > agent.contextResetAt)) {
    return messages.filter((m) => m.createdAt >= seenUntil && m.agentId !== agent.id && !m.isSystemNote);
  }

  let lastOwnIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    // isLocalCommandOnly messages are skipped as a "last own turn" boundary
    // for the same reason buildPromptBlocks' hasSpokenInChat skips them —
    // nothing sent alongside that turn (this catch-up window included)
    // actually reached the model, so it can't be trusted as a point the
    // session's memory picks up from. isSystemNote messages (a compaction
    // report — see Message.isSystemNote's docs) are skipped for the same
    // reason: nothing the model said, so not a real "last turn" either.
    if (
      messages[i].agentId === agent.id && !messages[i].isLocalCommandOnly && !messages[i].isSystemNote
      && (!agent.contextResetAt || messages[i].createdAt > agent.contextResetAt)
    ) { lastOwnIdx = i; break; }
  }
  // isSystemNote messages are never catch-up content for anyone — they're a
  // UI-only aside about one agent, not information another agent needs.
  return messages.slice(lastOwnIdx + 1).filter((m) => m.agentId !== agent.id && !m.isSystemNote);
}

/**
 * Formats the chat roster (every member except `agent` itself) the same
 * way in both buildSystemPreamble (the full first-turn introduction) and
 * buildPromptBlocks' standalone roster-refresh note (see its docs) — kept
 * as one function so those two call sites can never drift into describing
 * the roster differently.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @returns {string}
 */
function formatRoster(agent, members) {
  const teammates = members.filter((m) => m.id !== agent.id);
  // The agent's own line comes first: an agent introduced before ids were
  // shown never got told its own, and messages label authors by id.
  const self = `  - ${agentRef(agent)} — this is you`;
  return teammates.length
    ? [self, ...teammates.map((m) => `  - ${agentRef(m)} (working in ${m.workingDir})`)].join('\n')
    : `${self}\n  (no teammates — you are the only agent in this chat)`;
}

/**
 * Builds the [System] block that tells an agent who they are, who their
 * teammates are, and how the @mention routing model works. Only needed on
 * an agent's very first turn (see buildPromptBlocks) — confirmed
 * empirically (raw spawn spike, not guessed) that a resumed CLI session
 * keeps following instructions given this way in an earlier invocation
 * without them being restated, the same as it remembers plain conversation
 * content. Resending it every turn was pure duplication, same underlying
 * bug as the history replay in catchUpMessagesFor.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @returns {string}
 */
function buildSystemPreamble(agent, chat, members) {
  return [
    `[System]`,
    `You are being added to a chat under the name "${agent.name}" — this is your alias for this`,
    `conversation. If you already have unrelated prior context from another session or task, it's`,
    `still yours and you can draw on it if it's genuinely relevant, but don't let it define who you`,
    `are here: for this chat, you are ${agent.name}, an AI assistant operating in the directory:`,
    `${agent.workingDir}`,
    ``,
    `You are participating in a shared chat called "${chat.name}" with these AI agents:`,
    formatRoster(agent, members),
    ``,
    `How this multi-agent chat works:`,
    `- Every message is labelled with who wrote it: "Name [user]" for the user, "Name [agent <id>]" for an agent. Go by the label, not the name alone — names aren't guaranteed to be unique.`,
    `- The user routes messages using @mentions. If a message @mentions your name, only you respond.`,
    `- A mention counts wherever it appears in the message — at the start, buried mid-sentence, or the end — not just a leading or trailing line. A teammate's reply that mentions you partway through (e.g. after explaining their reasoning first) is exactly as real a trigger as one at the very top; don't wait for a mention to be the first thing you see before treating it as addressed to you.`,
    `- If no agent is @mentioned, the message went to everyone, and every teammate is already responding to it independently and in parallel — you don't need to @mention a teammate just to make sure they see or answer something they were already sent directly.`,
    `- To delegate a task to a teammate, write @Name in your response (e.g. "@Claudia please copy the file"). The system will automatically route your request to them so they act on it.`,
    `- Only use @Name to hand off something a teammate wouldn't otherwise already be doing — e.g. a follow-up specific to what YOU just found. Don't @mention someone to ask a question they were already asked directly; they're already independently answering it.`,
    `[/System]`,
  ].join('\n');
}

/**
 * Builds the full content-block array for a single agent response, in the
 * shape expected by the Claude CLI's `--input-format=stream-json` stdin
 * message. Prepends the [System] preamble (see buildSystemPreamble) on an
 * agent's first-ever turn IN THIS CHAT — every later turn skips it, since
 * the CLI session already has it.
 *
 * Deliberately gated on whether `agent.id` appears as the author of any
 * message in `priorMessages`, NOT on `agent.resumeId` — those are different
 * questions. `resumeId` only tells you whether the underlying `claude`
 * session has ANY memory at all; it does NOT tell you whether that memory
 * has anything to do with THIS chat. An agent can be created with a
 * manually-supplied resumeId pointing at a completely unrelated prior
 * session (see routes/agents.js's optional resumeId field) — resumeId-gating
 * would then skip the preamble entirely on its first turn here, leaving it
 * cold-dropped into [Since you last responded]-style catch-up context for a
 * conversation it was never part of, under a name/identity it was never
 * told about. Reported live: exactly that — an agent resumed from an
 * unrelated real session either got visibly confused by unexplained
 * catch-up context, or silently went along with a new identity it had no
 * actual grounding for. Gating on real chat history fixes both: a
 * resumed-from-elsewhere agent now gets properly introduced (as an alias,
 * see buildSystemPreamble) the first time it actually speaks in this chat,
 * exactly like a brand-new agent would.
 *
 * Also prepends whatever catch-up messages this agent doesn't already have
 * (see catchUpMessagesFor — attachments from those older messages are
 * summarized, not resent in full), then the new message's own attachments
 * (sent in full) and its typed text.
 *
 * Whenever there's catch-up content at all, a fresh roster line goes out
 * alongside it too (see formatRoster) — cheap (a few lines, not the whole
 * [System] preamble's @mention-routing essay) but necessary: an agent that
 * already spoke once never gets that essay resent, so without this, its own
 * idea of "who's in this chat" is frozen at whatever the roster was on its
 * LAST turn. Reported live, and made much more likely by the Observer
 * feature specifically (an observer can go a whole day between turns by
 * design — plenty of time for membership to change): a long-dormant agent
 * ends up holding a stale "(none — you are the only agent)" roster while
 * simultaneously reading catch-up content that plainly names teammates it
 * was never told about — a real, visible contradiction it correctly (if
 * confusingly, from the user's side) flagged as looking like injected
 * content. Gated on catch-up existing at all, not sent unconditionally on
 * every turn, for the same reason the full preamble isn't: if nothing
 * happened since this agent's last turn, the roster almost certainly
 * hasn't moved either — EXCEPT membership changes don't create a chat
 * message, so "no catch-up" doesn't actually rule out a roster change.
 * chat.rosterChangedAt (see db.js's addChatMember/removeChatMember) covers
 * that gap: also reported live, an agent whose last turn happened to be the
 * most recent thing in the chat at the time a teammate was removed carried
 * that stale roster forward with nothing to correct it, and went on to
 * @mention the departed teammate for a task no one would ever see — the
 * roster note now also fires when rosterChangedAt is newer than this
 * agent's own last turn, independent of catch-up content.
 *
 * @param {import('../store/db.js').Agent} agent - The agent being prompted
 * @param {import('../store/db.js').Chat} chat - The current chat
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @param {NewUserMessage} newMessage - The new user message
 * @param {import('../store/db.js').Message[]} priorMessages - Recent chat
 *   history. May or may not already include the message newMessage was
 *   derived from, depending on when the caller fetched it — excludeMessageId
 *   is the authoritative way to keep it from being resent twice.
 * @param {string} [excludeMessageId] - The DB id of the message newMessage
 *   was derived from, if it's already been persisted. Filtered out of
 *   priorMessages regardless of fetch timing, so it's never sent once as
 *   catch-up context AND again as this turn's own final content block.
 * @param {string[]} [alsoCatchUpIds] - Messages in priorMessages that go
 *   into catch-up whatever its boundary says: the earlier triggers of a
 *   turn others were folded into (see pendingTurns), which the agent has
 *   to see even when it has no recorded seenUntil yet.
 * @returns {import('../services/agentRunner.js').ContentBlock[]}
 */
export function buildPromptBlocks(agent, chat, members, newMessage, priorMessages, excludeMessageId, alsoCatchUpIds = []) {
  // isLocalCommandOnly/isSystemNote messages don't count — see
  // catchUpMessagesFor's docs on why they can't be trusted as evidence the
  // model ever saw anything sent alongside them, preamble included.
  const lastOwnMessage = [...priorMessages].reverse().find((m) => m.agentId === agent.id && !m.isLocalCommandOnly && !m.isSystemNote);
  // A "/clear" since that last turn (agent.contextResetAt — see its docs on
  // the Agent typedef) rotated this agent's live CLI session to a brand-new
  // one with zero memory, same as an agent that's never spoken in this chat
  // at all — so it gets the same full-preamble treatment rather than being
  // treated as already introduced.
  const clearedSinceLastTurn = Boolean(agent.contextResetAt && (!lastOwnMessage || agent.contextResetAt > lastOwnMessage.createdAt));
  const hasSpokenInChat = !clearedSinceLastTurn
    && priorMessages.some((m) => m.agentId === agent.id && !m.isLocalCommandOnly && !m.isSystemNote);
  const systemPreamble = hasSpokenInChat ? '' : buildSystemPreamble(agent, chat, members);

  const filteredPriorMessages = excludeMessageId
    ? priorMessages.filter((m) => m.id !== excludeMessageId)
    : priorMessages;
  const caughtUp = catchUpMessagesFor(agent, filteredPriorMessages);
  const catchUp = alsoCatchUpIds.length
    ? filteredPriorMessages.filter((m) => caughtUp.includes(m) || alsoCatchUpIds.includes(m.id))
    : caughtUp;
  const sectionLabel = hasSpokenInChat ? 'Since you last responded' : 'Conversation context';
  const contextSection = catchUp.length
    ? `[${sectionLabel}]\n${catchUp.map(renderHistoryLine).join('\n')}\n---`
    : '';
  // Membership changes (add/remove) don't create a chat message, so
  // catch-up content alone can't be trusted to reveal one — an agent whose
  // last turn was immediately before a teammate got removed, with no other
  // chat activity since, would otherwise carry that stale roster forward
  // indefinitely (and, reported live, sometimes @mention the departed
  // teammate asking them for something no one will ever see). rosterChangedAt
  // (bumped in db.js's addChatMember/removeChatMember) catches that case:
  // if it's newer than this agent's own last turn in the chat, the roster
  // note goes out even with zero catch-up content.
  const rosterStaleSinceLastTurn = Boolean(
    hasSpokenInChat && chat.rosterChangedAt && (!lastOwnMessage || chat.rosterChangedAt > lastOwnMessage.createdAt)
  );
  // Only needed when the full [System] preamble (which already includes an
  // up-to-date roster) wasn't sent, AND (there's catch-up content to pair it
  // with, OR the roster itself moved since this agent's last turn) — see
  // this function's docs for why.
  const rosterNote = hasSpokenInChat && (catchUp.length || rosterStaleSinceLastTurn)
    ? `[Current chat roster]\n${formatRoster(agent, members)}`
    : '';

  /** @type {import('../services/agentRunner.js').ContentBlock[]} */
  const blocks = [];
  const preambleText = [systemPreamble, rosterNote, contextSection].filter(Boolean).join('\n\n');
  // A resumed agent in a 1:1 chat can legitimately have nothing to prepend
  // at all (no preamble needed, nothing to catch up on) — skip pushing an
  // empty text block rather than sending one, since content blocks with
  // empty text risk rejection.
  if (preambleText) blocks.push({ type: 'text', text: preambleText });

  for (const att of newMessage.attachments ?? []) {
    if (att.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
    } else if (att.type === 'text') {
      blocks.push({ type: 'text', text: `[${att.name ?? 'Pasted text'}]\n${att.data}` });
    }
  }

  // Labelled with its author, the same way catch-up lines are. Without it a
  // user's message and a relayed teammate's reply reach the agent looking
  // identical. Reported live: an agent whose previous turn was a relay from
  // a teammate took the user's next question as coming from that teammate,
  // and addressed its answer to them instead of the user.
  const text = newMessage.content || '(see attached)';
  blocks.push({ type: 'text', text: newMessage.from ? `${authorLabel(newMessage.from)}: ${text}` : text });
  return blocks;
}

/**
 * Handles an incoming USER_MESSAGE event.
 * Saves the user message, determines responders, then runs agents sequentially.
 * @param {UserMessageEvent} event
 * @param {WebSocketServer} wss
 * @returns {Promise<{ userMessage: import('../store/db.js').Message | null, replies: import('../store/db.js').Message[] }>}
 *   `replies` is every agent Message this call produced, flattened across
 *   the initial responders and any relay rounds, in the order each batch
 *   resolved — not nested by round. Both existing callers (this file's own
 *   WS dispatch, and services/scheduler.js's fireScheduledMessage) ignore
 *   the return value; it exists so an in-process caller (the MCP `send_message`
 *   tool, server/mcp/tools.js) can await a real reply instead of firing and
 *   forgetting, without needing a WS client of its own.
 */
export async function handleUserMessage(event, wss) {
  const { chatId, content, attachments = [], asAgentId } = event;

  const chat = getChat(chatId);
  if (!chat) return { userMessage: null, replies: [] };

  // An agent posting into its own chat over MCP (asAgentId). Before this,
  // every send_message call was saved as the user's. Reported live: an
  // agent answered the user by posting "@Teammate …" through send_message,
  // so the chat showed the user saying it, and every agent reading the
  // chat after that took the user's messages as possibly a teammate's.
  const author = asAgentId && chat.memberAgentIds.includes(asAgentId) ? getAgent(asAgentId) : null;
  if (asAgentId && !author) return { userMessage: null, replies: [] };

  // Save the message. Named userMessage for the return shape's sake, but
  // it's the agent's own when `author` is set.
  /** @type {import('../store/db.js').Message} */
  const userMessage = {
    id: uuidv4(),
    chatId,
    role: author ? 'agent' : 'user',
    agentId: author?.id ?? null,
    authorName: author?.name ?? getUserDisplayName(),
    content,
    attachments,
    createdAt: new Date().toISOString(),
  };
  await addMessage(userMessage);

  /** @type {MessageSavedEvent} */
  broadcast(wss, { type: 'MESSAGE_SAVED', chatId, message: userMessage });

  // Determine which agents should respond
  const members = chat.memberAgentIds
    .map((id) => getAgent(id))
    .filter(Boolean);

  // "@Name /command ..." invokes that agent's Claude Code skill directly —
  // single-target, and the CLI-facing content is the bare command (stripped
  // of the "@Name " prefix), since the local slash-command parser only
  // recognizes a command when it's the start of the message it sees.
  //
  // An agent's own post is routed the way its reply would be relayed: only
  // to the teammates it @mentions, never broadcast, never as a skill
  // invocation, and never back to itself.
  const skillInvocation = author ? null : parseSkillInvocation(content, members);
  const responders = author
    ? extractMentionedAgents(content, members).filter((a) => a.id !== author.id)
    : skillInvocation ? [skillInvocation.agent] : parseResponders(content, members);
  if (responders.length === 0) return { userMessage, replies: [] };

  /** @type {NewUserMessage} */
  const originalMessage = { content, attachments, from: userMessage };
  /** @type {NewUserMessage} */
  const newMessage = skillInvocation ? { content: skillInvocation.command, attachments } : originalMessage;

  const respondedMessages = await runAgentsParallel(responders, members, chat, newMessage, wss, userMessage.id, { coalesce: !skillInvocation });
  const allReplies = [...respondedMessages.values()];

  // Relay: parse each round's just-saved agent responses for @mentions of
  // teammates, and trigger those teammates too, using the MENTIONING
  // TEAMMATE'S OWN REPLY as the turn's trigger content — never the original
  // user message (which typically doesn't mention the relay target at all,
  // and reads to the model as "not addressed to me", leaving it to just
  // hold) and never a stripped skill command (a relayed teammate isn't the
  // skill's target, and a bare "/command" as their own final content block
  // would risk misfiring an unrelated skill).
  //
  // Two modes, gated on chat.freeRelay:
  //   - Bounded (default): exactly one relay round, and never back to an
  //     agent who already responded this chain (the original depth-cap-1
  //     behavior — prevents even a two-agent ping-pong from starting).
  //   - Free (chat.freeRelay): rounds keep going — the same agent CAN be
  //     relayed again in a later round — for as long as each round actually
  //     produces new @mentions, up to FREE_RELAY_MAX_ROUNDS as a safety
  //     ceiling against a genuinely unbounded two-agent back-and-forth
  //     burning cost/time indefinitely.
  //
  // This applies to an auto-continue "please continue" reply too. An
  // earlier version skipped relay for those entirely, but the woken agent's
  // reply is usually it resuming real work, and its @mentions are real
  // hand-offs. Reported live: three agents woken by the same reset each
  // @mentioned teammates ("@Claus please commit"), and every one of those
  // mentions was silently dropped, so the work stalled.
  let roundMessages = respondedMessages;
  let round = 0;
  while (roundMessages.size > 0) {
    // Re-read chat/members fresh each round instead of reusing the outer
    // `chat`/`members` snapshot taken before ANY turn ran. Reported live: a
    // responder can itself call the MCP add_agent_to_chat tool mid-turn and
    // then @mention that same just-added teammate in its own reply — by the
    // time that reply is scanned here, DB membership already includes the
    // new agent, but the stale `members` list doesn't, so
    // extractMentionedAgents never recognizes the mention as a valid target
    // and the relay silently never fires (the mentioned agent's cost stays
    // $0 — it never even saw the message). Cheap (one more getChat/getAgent
    // pass per round) and correct for the opposite case too (a teammate
    // removed mid-chain stops being a valid relay target immediately).
    const currentChat = getChat(chatId) ?? chat;
    const currentMembers = currentChat.memberAgentIds.map((id) => getAgent(id)).filter(Boolean);

    // Scans only the messages produced by the PREVIOUS round, not a
    // re-fetched window from the DB — an agent's message from an earlier,
    // unrelated turn can still be among the chat's most recent rows (e.g. it
    // responded then, but not this time), and re-querying by "recent N"
    // would wrongly sweep its old @mention back in as if it were a fresh
    // relay trigger.
    const relayTargets = new Map(); // targetAgentId -> { agent, message } — first mention wins per round, so a target relays once per round even if multiple messages that round mention it
    for (const msg of roundMessages.values()) {
      // A reply that answered several chains' folded turns is in each of
      // their rounds; only the first chain to actually relay it does.
      if (relayScannedMessageIds.has(msg.id)) continue;
      for (const target of extractMentionedAgents(msg.content, currentMembers)) {
        if (target.id === msg.agentId) continue; // an agent mentioning itself doesn't relay to itself
        // An agent that posted over MCP is mid-turn, waiting for this very
        // chain to finish; a turn relayed to it would queue behind that
        // wait and never start.
        if (author && target.id === author.id) continue;
        if (!currentChat.freeRelay && respondedMessages.has(target.id)) continue; // bounded mode: never relay back to an original responder
        if (relayTargets.has(target.id)) continue;
        relayTargets.set(target.id, { agent: target, message: msg });
      }
    }
    if (relayTargets.size === 0) break;
    if (!currentChat.freeRelay && round >= 1) break; // bounded mode: exactly one relay round total
    if (currentChat.freeRelay && round >= FREE_RELAY_MAX_ROUNDS) {
      log.warn({ chatId: currentChat.id, rounds: round }, 'free relay hit its safety ceiling, stopping the chain');
      break;
    }
    // Only now, once this chain is definitely relaying: a chain that scans
    // a shared reply and then stops (bounded mode's one round) mustn't
    // take it away from one that would have relayed it.
    markRelayed(new Set([...relayTargets.values()].map(({ message }) => message.id)));

    // Grouped by triggering message so agents relayed by the same mention
    // still run together in one runAgentsParallel call; different mentions
    // run as separate parallel calls since each needs its own trigger
    // content and its own excludeMessageId (that message, so it isn't
    // duplicated into its own catch-up).
    const relayGroups = new Map(); // messageId -> { message, agents: [] }
    for (const { agent, message } of relayTargets.values()) {
      if (!relayGroups.has(message.id)) relayGroups.set(message.id, { message, agents: [] });
      relayGroups.get(message.id).agents.push(agent);
    }
    const results = await Promise.allSettled(
      [...relayGroups.values()].map(({ message, agents }) =>
        runAgentsParallel(
          agents,
          currentMembers,
          currentChat,
          { content: message.content, attachments: message.attachments, from: message },
          wss,
          message.id,
          { coalesce: true }
        )
      )
    );

    const nextRoundMessages = new Map();
    for (const result of results) {
      if (result.status === 'fulfilled') for (const [id, msg] of result.value) nextRoundMessages.set(id, msg);
    }
    allReplies.push(...nextRoundMessages.values());
    roundMessages = nextRoundMessages;
    round++;
  }

  return { userMessage, replies: allReplies };
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundTurn for a
 * given agent: persists and broadcasts a turn the CLI resumed and reported
 * on entirely unprompted — see onBackgroundTurn's own docs for the exact
 * mechanism (a backgrounded Bash task finishing is the common trigger) and
 * AgentBackgroundMessageEvent for the wire shape. This can fire long after
 * whichever runAgentsParallel call originally registered it has already
 * returned, against a chat/agent state that may have changed since — so
 * everything here is looked up fresh at delivery time rather than closed
 * over.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {(turn: { text: string, toolCalls: import('../services/agentProcessManager.js').ToolCall[], sessionId: string | null, permissionDenials: import('../services/agentRunner.js').PermissionDenial[], model: string | null }) => Promise<void>}
 */
function makeBackgroundTurnHandler(agentId, wss) {
  return async ({ streamId, text, toolCalls, permissionDenials, model }) => {
    const agent = getAgent(agentId);
    const chatId = getAgentChatId(agentId);
    // Agent was deleted, or removed from every chat, between whenever this
    // background task was kicked off and it actually finishing — nowhere
    // left to report into.
    if (!agent || !chatId) {
      discardBackgroundStream(streamId, wss);
      return;
    }
    if (streamId) activeStreams.delete(streamId);

    if (model) {
      const updated = await setAgentModel(agentId, model);
      if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
    }
    // A real background completion means this agent isn't session-limited
    // any more, whatever a past background failure (see onBackgroundError)
    // once set — same reasoning as runAgentsParallel's own clearedLimit.
    const clearedLimit = await setAgentSessionLimitReset(agentId, null);
    if (clearedLimit) broadcast(wss, { type: 'AGENT_UPDATED', agent: clearedLimit });

    /** @type {import('../store/db.js').Message} */
    const agentMessage = {
      id: uuidv4(),
      chatId,
      role: 'agent',
      agentId,
      authorName: agent.name,
      content: text,
      attachments: [],
      toolCalls,
      createdAt: new Date().toISOString(),
    };
    await addMessage(agentMessage);
    log.info({ agentId, chatId }, 'agent reported back on a background task unprompted');

    /** @type {AgentBackgroundMessageEvent} */
    broadcast(wss, {
      type: 'AGENT_BACKGROUND_MESSAGE',
      chatId,
      agentId,
      message: agentMessage,
      permissionDenials: dedupePermissionDenials(permissionDenials),
      streamId,
    });
  };
}

/**
 * Builds the factory passed to agentProcessManager's onBackgroundStream for
 * a given agent: opens a live stream — the exact same activeStreams entry +
 * AGENT_STREAM_START/CHUNK/STATUS events an explicit turn gets — the moment
 * the CLI starts a turn on its own, so a long self-resumed turn shows its
 * progress live instead of looking idle until it finishes (see
 * onBackgroundStream's docs). Closed by makeBackgroundTurnHandler's
 * AGENT_BACKGROUND_MESSAGE, or discardBackgroundStream otherwise. Stopping it
 * kills the agent's process, the only way to interrupt a turn nobody wrote
 * to stdin; the exit then discards the stream.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {() => import('../services/agentProcessManager.js').BackgroundStream | null}
 */
function makeBackgroundStreamFactory(agentId, wss) {
  return () => {
    const agent = getAgent(agentId);
    const chatId = getAgentChatId(agentId);
    if (!agent || !chatId) return null;
    const streamId = uuidv4();
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => { killAgent(agentId, { immediate: true }); });
    activeStreams.set(streamId, {
      controller,
      chatId,
      agentId,
      agentName: agent.name,
      agentColor: agent.color,
      startedAt: Date.now(),
      text: '',
      statusText: '',
    });
    /** @type {AgentStreamStartEvent} */
    broadcast(wss, { type: 'AGENT_STREAM_START', chatId, agentId, streamId, agentName: agent.name, agentColor: agent.color });
    log.info({ agentId, chatId, streamId }, 'agent started a turn unprompted');
    return {
      streamId,
      onChunk: (text) => {
        const stream = activeStreams.get(streamId);
        if (stream) stream.text += text;
        broadcast(wss, { type: 'AGENT_STREAM_CHUNK', streamId, chatId, agentId, text });
      },
      onStatus: (status) => {
        const stream = activeStreams.get(streamId);
        if (stream) stream.statusText = status;
        broadcast(wss, { type: 'AGENT_STREAM_STATUS', streamId, chatId, agentId, status });
      },
      discard: () => discardBackgroundStream(streamId, wss),
    };
  };
}

/**
 * Closes a background stream (see makeBackgroundStreamFactory) that won't be
 * replaced by a persisted message. A no-op for a null/already-closed one.
 * @param {string | null} streamId
 * @param {WebSocketServer} wss
 */
function discardBackgroundStream(streamId, wss) {
  if (!streamId) return;
  const stream = activeStreams.get(streamId);
  if (!stream) return;
  activeStreams.delete(streamId);
  /** @type {AgentStreamDiscardEvent} */
  broadcast(wss, { type: 'AGENT_STREAM_DISCARD', streamId, chatId: stream.chatId, agentId: stream.agentId });
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundTasksChanged
 * for a given agent — see AgentBackgroundTasksEvent.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {(tasks: import('../services/agentProcessManager.js').BackgroundTask[]) => void}
 */
function makeBackgroundTasksHandler(agentId, wss) {
  return (tasks) => {
    /** @type {AgentBackgroundTasksEvent} */
    broadcast(wss, { type: 'AGENT_BACKGROUND_TASKS', agentId, tasks });
  };
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundCompaction
 * for a given agent: posts the same 🗜️ system note postCompactionNotes
 * posts for a compaction that happened mid-explicit-turn, for one the CLI
 * reported while the agent was otherwise idle instead (see that function's
 * own docs for the mechanism). Looked up fresh at delivery time, same
 * reasoning as makeBackgroundTurnHandler just above.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {(compaction: { trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }) => Promise<void>}
 */
function makeBackgroundCompactionHandler(agentId, wss) {
  return async (compaction) => {
    const agent = getAgent(agentId);
    const chatId = getAgentChatId(agentId);
    if (!agent || !chatId) return;
    const chat = getChat(chatId);
    if (!chat) return;
    await postCompactionNotes(chat, agent, [compaction], wss);
  };
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundError for a
 * given agent: the background-turn equivalent of runAgentsParallel's own
 * catch block, for a turn the CLI resumed and ran entirely unprompted but
 * that ended in is_error:true rather than real content (see onBackgroundError's
 * docs for why this exists and the incident that motivated it). Deliberately
 * does NOT persist or broadcast a chat message — unlike makeBackgroundTurnHandler,
 * there is no genuine agent reply here, only a failed retry, so this just
 * does the same session-limit bookkeeping an explicit turn's error gets:
 * stamp the informational badge, and — only if this chat opted into
 * chat.autoContinue — (re-)arm the same cancelable scheduled nudge a user
 * would get from an explicit turn hitting the same wall.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {({ errorMessage: string, streamId: string | null }) => Promise<void>}
 */
function makeBackgroundErrorHandler(agentId, wss) {
  return async ({ errorMessage, streamId }) => {
    discardBackgroundStream(streamId, wss);
    const agent = getAgent(agentId);
    const chatId = getAgentChatId(agentId);
    if (!agent || !chatId) return;
    const chat = getChat(chatId);
    if (!chat) return;

    log.warn({ agentId, chatId, errorMessage }, 'agent background retry errored');

    const resetAt = parseSessionLimitReset(errorMessage);
    if (resetAt) {
      const updated = await setAgentSessionLimitReset(agentId, resetAt.toISOString());
      if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
    }
    await maybeScheduleAutoContinue(chat, agent, resetAt, wss);
  };
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundUsage for a
 * given agent: records a self-resumed turn's spend exactly like an explicit
 * turn's (setAgentUsage + AGENT_UPDATED), and logs it the same way the
 * 'turn ended'/'turn errored' lines do, so background spend shows up in
 * both the 💰 badge and the log instead of neither.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {(usage: import('../services/agentProcessManager.js').BackgroundUsage) => Promise<void>}
 */
function makeBackgroundUsageHandler(agentId, wss) {
  return async ({ usage, contextTokens, totalCostUsd, durationMs, isError }) => {
    log.info(
      {
        agentId,
        chatId: getAgentChatId(agentId),
        ...(usage ?? {}),
        totalCostUsd,
        durationMs,
        isError,
      },
      'background turn ended'
    );
    const updated = await setAgentUsage(agentId, { totalCostUsd, contextTokens });
    if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
  };
}

/**
 * Scheduled-message content that nudges a single agent to continue once its
 * session limit resets. @-targeted (not a bare "please continue") so
 * parseResponders resolves it to just that agent at fire time, not a
 * broadcast to the whole chat — see messageRouter.js.
 * @param {import('../store/db.js').Agent} agent
 * @returns {string}
 */
function buildAutoContinueMessage(agent) {
  return `@${agent.name} Your session limit has reset. Please continue with what you were doing.`;
}

/**
 * Persists and broadcasts one isSystemNote message per context-compaction
 * the CLI's own --autocompact (or a manual /compact) reported for this turn
 * (see agentProcessManager.js's compact_boundary handling) — otherwise
 * invisible to the user (confirmed directly against the installed CLI
 * binary: it's a real stream-json event this app never surfaced anywhere).
 * A no-op for the normal case of zero compactions. Deliberately does NOT
 * touch the `responded` map runAgentsParallel's callers use for relay
 * @mention scanning — a compaction note is never itself relay-worthy.
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent} agent
 * @param {{ trigger: 'auto' | 'manual', preTokens: number | null, postTokens: number | null }[] | undefined} compactions
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
async function postCompactionNotes(chat, agent, compactions, wss) {
  for (const { trigger, preTokens, postTokens } of compactions ?? []) {
    const tokenSummary = preTokens != null && postTokens != null
      ? `${preTokens.toLocaleString()} → ${postTokens.toLocaleString()} tokens`
      : 'size unreported';
    /** @type {import('../store/db.js').Message} */
    const noteMessage = {
      id: uuidv4(),
      chatId: chat.id,
      role: 'agent',
      agentId: agent.id,
      authorName: agent.name,
      // Named in the text itself: a system note renders as a plain centered
      // line with no author shown, so without it there was no telling
      // whose context was compacted.
      content: `🗜️ ${agent.name}'s context was compacted (${trigger}): ${tokenSummary}`,
      attachments: [],
      toolCalls: [],
      isSystemNote: true,
      createdAt: new Date().toISOString(),
    };
    await addMessage(noteMessage);
    /** @type {MessageSavedEvent} */
    broadcast(wss, { type: 'MESSAGE_SAVED', chatId: chat.id, message: noteMessage });
  }
}

/**
 * Who took a roster-changing action (added or removed an agent from a
 * chat, or deleted one outright) — the only two surfaces that can do any
 * of these are a REST call from the browser tab ('user' — the app has no
 * auth, so this is always the single local operator, see CLAUDE.md) or an
 * external Claude instance driving Clauhort over /mcp ('mcp' — see
 * mcp/tools.js). An MCP caller has no finer-grained identity than the
 * bearer token it connected with, so 'mcp' is as specific as this can get.
 * @typedef {'user' | 'mcp'} RosterActor
 */

/**
 * Persists and broadcasts one isSystemNote message recording that `agent`
 * was removed from `chat` — either unmembered or deleted outright — so the
 * chat keeps a visible, searchable record of who/what did it. Mirrors
 * postCompactionNotes above, except `agentId` here is set to the REMOVED
 * agent's id specifically so the per-agent message filter still surfaces
 * this note when filtering to that agent, even though the removal itself
 * never reached its session.
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent} agent - the agent that was removed
 * @param {RosterActor} actor
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
export async function postAgentRemovedNote(chat, agent, actor, wss) {
  const actorLabel = actor === 'mcp' ? 'An MCP client' : 'You';
  /** @type {import('../store/db.js').Message} */
  const noteMessage = {
    id: uuidv4(),
    chatId: chat.id,
    role: 'agent',
    agentId: agent.id,
    authorName: 'System',
    // With the id, since names aren't unique: two agents called Ada would
    // otherwise leave identical notes.
    content: `🚪 ${actorLabel} removed ${agentRef(agent)} from the chat`,
    attachments: [],
    toolCalls: [],
    isSystemNote: true,
    createdAt: new Date().toISOString(),
  };
  await addMessage(noteMessage);
  /** @type {MessageSavedEvent} */
  broadcast(wss, { type: 'MESSAGE_SAVED', chatId: chat.id, message: noteMessage });
}

/**
 * Persists and broadcasts one isSystemNote message recording that `agent`
 * was added to `chat` — symmetric with postAgentRemovedNote just above,
 * same reasoning (a visible, searchable record of who/what changed the
 * roster, and telling a REST/UI add apart from one made by an external
 * Claude instance over /mcp). Deliberately not wired into bulk-membership
 * paths (create_chat's initial memberAgentIds, say) — same scope
 * postAgentRemovedNote itself keeps by staying out of delete_chat — this
 * is for the single add_agent_to_chat/POST .../members action a human or
 * an MCP client takes against an already-existing chat.
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent} agent - the agent that was added
 * @param {RosterActor} actor
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
export async function postAgentAddedNote(chat, agent, actor, wss) {
  const actorLabel = actor === 'mcp' ? 'An MCP client' : 'You';
  /** @type {import('../store/db.js').Message} */
  const noteMessage = {
    id: uuidv4(),
    chatId: chat.id,
    role: 'agent',
    agentId: agent.id,
    authorName: 'System',
    // With the id — see postAgentRemovedNote.
    content: `➕ ${actorLabel} added ${agentRef(agent)} to the chat`,
    attachments: [],
    toolCalls: [],
    isSystemNote: true,
    createdAt: new Date().toISOString(),
  };
  await addMessage(noteMessage);
  /** @type {MessageSavedEvent} */
  broadcast(wss, { type: 'MESSAGE_SAVED', chatId: chat.id, message: noteMessage });
}

/**
 * chat.autoContinue's whole mechanism: when an agent's turn errors out on
 * Claude's own session-limit message ("You've hit your session limit ·
 * resets 7:20pm (Australia/Darwin)" — see services/sessionLimitReset.js),
 * auto-arms a scheduled message targeted at just that agent for one minute
 * after the limit resets — the exact same mechanism a user gets from the
 * scheduled-message panel (visible there, cancelable, survives a restart),
 * so the user doesn't have to notice the limit cleared and say "please go
 * on" themselves.
 *
 * A silent no-op whenever `resetAt` is null (the error text didn't actually
 * name a reset time — see parseSessionLimitReset) — this runs on EVERY turn
 * error in an autoContinue chat, not just session-limit ones, so anything
 * else (a bad --resume flag, a crashed process) must fall through without
 * scheduling anything.
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent} agent
 * @param {Date | null} resetAt - already parsed by the caller, which also
 *   persists it onto the agent record regardless of chat.autoContinue
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
async function maybeScheduleAutoContinue(chat, agent, resetAt, wss) {
  if (!chat.autoContinue) return;
  if (!resetAt) return;
  const content = buildAutoContinueMessage(agent);
  // A freeRelay chat can retry the same agent across several relay rounds
  // within one cascade — if it's still over its (account-wide) limit on
  // every retry, each retry lands here again. Without this guard that piles
  // up duplicate pending continuations for the same agent, all firing at
  // once the moment the limit resets and re-triggering the very cascade
  // that caused this in the first place.
  const alreadyPending = getScheduledMessages(chat.id).some((m) => m.content === content);
  if (alreadyPending) return;
  const sendAt = new Date(resetAt.getTime() + 60_000);
  const row = await createScheduledMessage({
    id: uuidv4(),
    chatId: chat.id,
    content: buildAutoContinueMessage(agent),
    attachments: [],
    sendAt: sendAt.toISOString(),
    isAutoContinue: true,
  });
  scheduleTimer(row, wss);
  log.info({ agentId: agent.id, chatId: chat.id, sendAt: row.sendAt }, 'auto-continue scheduled after session limit');
}

/**
 * Runs a set of agents in parallel, streaming each response as it arrives.
 * Saves every completed response before resolving.
 * Returns the messages produced, keyed by agent ID — not just which agents
 * responded, so callers can inspect content from THIS call only, without
 * re-querying the DB and risking a stale message from an earlier turn.
 *
 * @param {import('../store/db.js').Agent[]} agents
 * @param {import('../store/db.js').Agent[]} allMembers
 * @param {import('../store/db.js').Chat} chat
 * @param {NewUserMessage} userMessage - The triggering user message
 * @param {WebSocketServer} wss
 * @param {string} [excludeMessageId] - Forwarded to buildPromptBlocks — see
 *   its docs.
 * @param {{ coalesce?: boolean }} [options] - `coalesce`: if the agent
 *   already has a turn waiting in this chat, join it rather than queue
 *   another, and share its reply. Only for a trigger that's a saved chat
 *   message (excludeMessageId), sent as-is: a skill invocation or a
 *   permission continuation has to reach the agent exactly as given.
 * @returns {Promise<Map<string, import('../store/db.js').Message>>}
 */
async function runAgentsParallel(agents, allMembers, chat, userMessage, wss, excludeMessageId, { coalesce = false } = {}) {
  const responded = new Map();
  const canCoalesce = coalesce && Boolean(excludeMessageId);

  await Promise.allSettled(agents.map(async (agent) => {
    const pendingKey = `${chat.id}:${agent.id}`;
    const waiting = canCoalesce ? pendingTurns.get(pendingKey) : undefined;
    if (waiting) {
      // The waiting turn hasn't built its prompt yet, so it will answer
      // this message, with the one it was waiting on shown as catch-up.
      // Reported live: an agent in a nine-minute turn had six more turns
      // queue up behind it and answered each one separately.
      waiting.foldedMessageIds.push(waiting.trigger.excludeMessageId);
      waiting.trigger = { message: userMessage, excludeMessageId };
      log.info({ agentId: agent.id, chatId: chat.id }, 'turn folded into one already waiting');
      const reply = await waiting.reply;
      if (reply) responded.set(agent.id, reply);
      return;
    }
    const shown = canCoalesce ? shownTurns.get(pendingKey) : undefined;
    if (shown?.messageIds.has(excludeMessageId)) {
      // Still running: its reply answers this too, so share it like a
      // folded turn. Already done: that reply was relayed back then.
      log.info({ agentId: agent.id, chatId: chat.id, done: shown.done }, 'trigger already shown to agent, no turn queued');
      const reply = shown.done ? null : await shown.reply;
      if (reply) responded.set(agent.id, reply);
      return;
    }
    /** @type {(reply: import('../store/db.js').Message | null) => void} */
    let settleReply = () => {};
    /** @type {PendingTurn} */
    const pending = {
      trigger: { message: userMessage, excludeMessageId },
      foldedMessageIds: [],
      reply: new Promise((resolve) => { settleReply = resolve; }),
    };
    if (canCoalesce) pendingTurns.set(pendingKey, pending);

    const streamId = uuidv4();
    /** @type {string | null} */
    let promptBuiltAt = null;
    /** @type {ShownTurn | null} */
    let shownTurn = null;
    let ranToCompletion = false;
    // Built when the turn actually starts, not now. A busy agent's turn
    // waits behind the one it's running, and a prompt built at queue time
    // is out of date by the time it's sent: reported live, an agent stuck
    // in a nine-minute turn had six more queued, each carrying the same
    // catch-up, and it answered every one as a "stale replay" — replies
    // that @mentioned teammates and set off the same thing for them.
    // Everything is read fresh here for the same reason (an earlier queued
    // turn may have set resumeId, or the roster may have changed).
    const buildContent = () => {
      // Started: anything for this agent from now on queues behind it.
      if (pendingTurns.get(pendingKey) === pending) pendingTurns.delete(pendingKey);
      const freshAgent = getAgent(agent.id) ?? agent;
      const freshChat = getChat(chat.id) ?? chat;
      const freshMembers = freshChat.memberAgentIds.map((id) => getAgent(id)).filter(Boolean);
      // An observer needs far more than the normal 20-message catch-up
      // window — see OBSERVER_HISTORY_LIMIT's docs. Normal worker agents
      // already have their own session memory via --resume, so re-sending
      // more than the recent window would be pure duplication for them
      // (same reasoning catchUpMessagesFor's own docs give).
      const priorMessages = getMessages(chat.id, freshAgent.isObserver ? OBSERVER_HISTORY_LIMIT : 20);
      promptBuiltAt = new Date().toISOString();
      const { message, excludeMessageId: triggerId } = pending.trigger;
      shownTurn = { messageIds: new Set([...priorMessages.map((m) => m.id), triggerId]), reply: pending.reply, done: false };
      shownTurns.set(pendingKey, shownTurn);
      const content = buildPromptBlocks(freshAgent, freshChat, freshMembers, message, priorMessages, triggerId, pending.foldedMessageIds);
      logTranscript({ chatId: chat.id, agentId: agent.id, agentName: agent.name, streamId, direction: 'SENT', content });
      return content;
    };
    const controller = new AbortController();
    activeStreams.set(streamId, {
      controller,
      chatId: chat.id,
      agentId: agent.id,
      agentName: agent.name,
      agentColor: agent.color,
      startedAt: Date.now(),
      text: '',
      statusText: '',
    });
    // Registered before this turn even starts (not just after it ends) —
    // the process this turn spawns/reuses is what might later resume and
    // report on a backgrounded task entirely unprompted, so the handler
    // needs to already be in place for that, however long after this
    // specific turn resolves it happens to fire. Re-registering per turn
    // is cheap (a Map.set) and keeps this agnostic of exactly when in the
    // agent's lifecycle its process first comes alive.
    onBackgroundTurn(agent.id, makeBackgroundTurnHandler(agent.id, wss));
    onBackgroundCompaction(agent.id, makeBackgroundCompactionHandler(agent.id, wss));
    onBackgroundError(agent.id, makeBackgroundErrorHandler(agent.id, wss));
    onBackgroundUsage(agent.id, makeBackgroundUsageHandler(agent.id, wss));
    onBackgroundStream(agent.id, makeBackgroundStreamFactory(agent.id, wss));
    onBackgroundTasksChanged(agent.id, makeBackgroundTasksHandler(agent.id, wss));

    /** @type {AgentStreamStartEvent} */
    broadcast(wss, {
      type: 'AGENT_STREAM_START',
      chatId: chat.id,
      agentId: agent.id,
      streamId,
      agentName: agent.name,
      agentColor: agent.color,
    });
    log.info({ agentId: agent.id, chatId: chat.id, streamId }, 'turn started');

    try {
      const { text: fullText, permissionDenials, sessionId, stopped, toolCalls, wasLocalCommand, contextCleared, usage, contextTokens, totalCostUsd, durationMs, model, compactions } = await runAgentStream({
        agent,
        chatId: chat.id,
        content: buildContent,
        streamId,
        signal: controller.signal,
        onChunk: (text) => {
          const stream = activeStreams.get(streamId);
          if (stream) stream.text += text;
          /** @type {AgentStreamChunkEvent} */
          broadcast(wss, {
            type: 'AGENT_STREAM_CHUNK',
            streamId,
            chatId: chat.id,
            agentId: agent.id,
            text,
          });
        },
        onStatus: (status) => {
          const stream = activeStreams.get(streamId);
          if (stream) stream.statusText = status;
          /** @type {AgentStreamStatusEvent} */
          broadcast(wss, {
            type: 'AGENT_STREAM_STATUS',
            streamId,
            chatId: chat.id,
            agentId: agent.id,
            status,
          });
        },
      });
      logTranscript({ chatId: chat.id, agentId: agent.id, agentName: agent.name, streamId, direction: 'RECEIVED', content: fullText });
      // Only a turn the model actually ran counts as seen. A stopped turn
      // may have been cut off before its prompt got anywhere, and a local
      // command never reached the model: catching up from the older
      // boundary re-sends a few lines, where moving it would lose them.
      if (promptBuiltAt && !stopped && !wasLocalCommand) {
        setAgentSeenUntil(agent.id, promptBuiltAt);
        ranToCompletion = true;
      }

      if (contextCleared && sessionId) {
        // A "/clear" rotated this agent's CLI session to a brand-new
        // session_id — recordContextClear overwrites resumeId
        // unconditionally (unlike setAgentResumeIdIfUnset below, whose
        // "only if unset" semantics would otherwise silently discard this)
        // and stamps contextResetAt so buildPromptBlocks/catchUpMessagesFor
        // know not to trust this agent's pre-clear session memory anymore.
        const updated = await recordContextClear(agent.id, sessionId);
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      } else if (sessionId && !agent.resumeId) {
        const updated = await setAgentResumeIdIfUnset(agent.id, sessionId);
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }
      // wasLocalCommand turns never touched the real model (see
      // createTurnAccumulator's docs), so `model` is already null for
      // those — nothing to persist, same as a crash-before-output turn.
      if (model) {
        const updated = await setAgentModel(agent.id, model);
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }
      if (usage) {
        const updated = await setAgentUsage(agent.id, {
          totalCostUsd,
          contextTokens,
        });
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }
      // A real (non-error) turn completing at all means this agent is no
      // longer session-limited, whatever a past error once said — no-ops
      // via setAgentSessionLimitReset's own guard when already unset.
      const clearedLimit = await setAgentSessionLimitReset(agent.id, null);
      if (clearedLimit) broadcast(wss, { type: 'AGENT_UPDATED', agent: clearedLimit });

      // A "/compact" turn produces no text at all, only the compaction
      // itself. Its 🗜️ note (postCompactionNotes) says what happened, so
      // saving the empty reply too just left a blank bubble beside it.
      if (!fullText && !stopped && !contextCleared && compactions?.length) {
        broadcast(wss, { type: 'AGENT_STREAM_DISCARD', streamId, chatId: chat.id, agentId: agent.id });
        await postCompactionNotes(chat, agent, compactions, wss);
        log.info({ agentId: agent.id, chatId: chat.id, streamId, durationMs }, 'turn ended with only a compaction');
        return;
      }

      /** @type {import('../store/db.js').Message} */
      const agentMessage = {
        id: uuidv4(),
        chatId: chat.id,
        role: 'agent',
        agentId: agent.id,
        authorName: agent.name,
        // A "/clear" (contextCleared) never produces real assistant text —
        // see agentProcessManager.js's conversation_reset handling — so
        // this becomes a system note ("starting fresh"), the same way a
        // context-compaction report does (postCompactionNotes), rather
        // than a blank reply bubble. Otherwise, a stop right at the very
        // start (before any text streamed) would otherwise persist a blank
        // message — fall back to a placeholder so the chat still shows
        // something happened.
        content: contextCleared
          ? `🧹 ${agent.name}'s context was cleared — starting a fresh session`
          : (fullText || (stopped ? t('chat.stoppedEmptyPlaceholder') : '')),
        attachments: [],
        toolCalls,
        createdAt: new Date().toISOString(),
      };
      if (wasLocalCommand) agentMessage.isLocalCommandOnly = true;
      if (contextCleared) agentMessage.isSystemNote = true;
      await addMessage(agentMessage);
      // A context-clear note is informational, not a real reply — never
      // relay-worthy, same reasoning postCompactionNotes gives for not
      // touching `responded` either.
      if (!contextCleared) {
        responded.set(agent.id, agentMessage);
        settleReply(agentMessage);
      }

      const dedupedDenials = dedupePermissionDenials(permissionDenials);
      /** @type {AgentStreamEndEvent} */
      broadcast(wss, {
        type: 'AGENT_STREAM_END',
        streamId,
        chatId: chat.id,
        agentId: agent.id,
        fullText,
        message: agentMessage,
        // Deduped here, not just left to the client's own exact-match guard
        // — this catches the Bash-specific case where two DIFFERENT literal
        // denials (a chain vs. one of its parts, piped vs. unpiped) still
        // derive an overlapping --allowedTools pattern, so granting one
        // already covers the other. Only the server knows CLI pattern
        // syntax well enough to reason about that.
        permissionDenials: dedupedDenials,
        stopped,
      });
      await postCompactionNotes(chat, agent, compactions, wss);
      log.info(
        {
          agentId: agent.id,
          chatId: chat.id,
          streamId,
          stopped,
          permissionDenials: dedupedDenials.map((d) => d.tool_name),
          // Token accounting straight from the CLI's own `result` event —
          // see providers/claude.js's createTurnAccumulator. This (plus
          // the mirrored fields on 'turn errored' below) is what makes a
          // token-burn incident (e.g. a shared account's session limit
          // getting exhausted by concurrent agent turns) debuggable from
          // the log after the fact, per agent/chat/turn, instead of guesswork.
          ...(usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
          } : {}),
          totalCostUsd,
          durationMs,
        },
        'turn ended'
      );
    } catch (err) {
      /** @type {AgentStreamErrorEvent} */
      broadcast(wss, {
        type: 'AGENT_STREAM_ERROR',
        streamId,
        chatId: chat.id,
        agentId: agent.id,
        error: err.message,
      });
      log.error(
        {
          agentId: agent.id,
          chatId: chat.id,
          streamId,
          err,
          // Same reasoning as 'turn ended' above — an errored turn (e.g. a
          // session-limit failure) still spent real tokens before it hit
          // the wall, and agentProcessManager.js's runOneTurn attaches
          // whatever the CLI's `result` event reported onto the Error
          // itself for exactly this.
          ...(err.usage ? {
            inputTokens: err.usage.inputTokens,
            outputTokens: err.usage.outputTokens,
            cacheCreationInputTokens: err.usage.cacheCreationInputTokens,
            cacheReadInputTokens: err.usage.cacheReadInputTokens,
          } : {}),
          totalCostUsd: err.totalCostUsd ?? null,
          durationMs: err.durationMs ?? null,
        },
        'turn errored'
      );
      if (err.usage) {
        const updated = await setAgentUsage(agent.id, {
          totalCostUsd: err.totalCostUsd,
          contextTokens: err.contextTokens ?? null,
        });
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }
      await postCompactionNotes(chat, agent, err.compactions, wss);
      // Persisted regardless of chat.autoContinue (unlike the scheduling
      // below, which is opt-in) — this is purely an informational badge in
      // the agent panel, not a "please continue" side effect.
      const resetAt = parseSessionLimitReset(err.message);
      if (resetAt) {
        const updated = await setAgentSessionLimitReset(agent.id, resetAt.toISOString());
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }
      await maybeScheduleAutoContinue(chat, agent, resetAt, wss);
    } finally {
      activeStreams.delete(streamId);
      // A turn that never started (e.g. its workingDir is gone) leaves
      // nothing for later triggers to join.
      if (pendingTurns.get(pendingKey) === pending) pendingTurns.delete(pendingKey);
      // Same rule as seenUntil: a stopped, local-command or errored turn
      // doesn't count as having shown the agent anything.
      if (shownTurn && shownTurns.get(pendingKey) === shownTurn) {
        if (ranToCompletion) shownTurn.done = true;
        else shownTurns.delete(pendingKey);
      }
      settleReply(null);
    }
  }));

  return responded;
}

/**
 * Registers event listeners for a new WebSocket connection.
 * @param {WebSocket} ws - The incoming client WebSocket
 * @param {import('http').IncomingMessage} _req
 * @param {WebSocketServer} wss
 */
export function handleConnection(ws, _req, wss) {
  ws.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case 'USER_MESSAGE':
        await handleUserMessage(event, wss);
        break;
      case 'GRANT_PERMISSION': {
        // { type: 'GRANT_PERMISSION', agentId: string, chatId?: string, toolName: string,
        //   value: string, autoContinue: boolean, outcomes?: PermissionOutcome[] }
        // File-path-scoped tools (Write/Edit/Read/NotebookEdit) widen --add-dir
        // scope; everything else (Bash, etc.) derives one or more
        // --allowedTools patterns instead — --add-dir can't authorize a
        // command. A chained Bash command derives a pattern per sub-command
        // (see deriveToolPatterns), so grant each in turn.
        //
        // --add-dir requires an actual DIRECTORY — passing the exact file
        // path (what the denial's tool_input.file_path is) is silently a
        // no-op, confirmed empirically: --add-dir <file> still gets denied,
        // --add-dir <dirname(file)> doesn't. So grant the file's containing
        // directory, not the literal denied value.
        //
        // Persisted unconditionally, regardless of autoContinue — a grant
        // should stick the moment it's clicked, even if sibling rows in the
        // same card are still unresolved (e.g. the tab closes before the
        // user finishes the card). Only the AUTO-CONTINUE nudge below is
        // deferred until the whole card is resolved.
        // Saved and applied under the agent's permission lock, so a later
        // row's auto-continue below only runs once this grant is fully in
        // place — see withPermissionLock.
        const granted = await withPermissionLock(event.agentId, async () => {
          let updated;
          if (FILE_PATH_TOOLS.includes(event.toolName)) {
            updated = await grantAgentPath(event.agentId, dirname(event.value));
          } else {
            for (const pattern of deriveToolPatterns(event.toolName, event.value)) {
              updated = await grantAgentToolPattern(event.agentId, pattern);
            }
          }
          if (!updated) return null;

          // --add-dir/--allowedTools are CLI startup flags, baked into the
          // agent's persistent process at spawn time — a running process
          // has no way to pick up a just-widened grant, so evict it now.
          // The next turn (the auto-continue below, or any later message)
          // respawns fresh with the updated flags, resuming via --resume so
          // no conversation memory is lost. Unconditional (not just when
          // autoContinue is true) — a still-mid-card grant needs this too,
          // or a LATER row's own auto-continue would still run against the
          // stale process.
          await killAgent(updated.id);
          broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
          return updated;
        });
        if (!granted) break;
        // Re-read: grants from sibling rows that ran before this one are
        // in the DB, not necessarily in the object this grant returned.
        const agent = getAgent(granted.id) ?? granted;

        // Granting only updates the agent's stored permissions — it doesn't
        // make the already-finished turn retry itself. Auto-continue once
        // every row in this card is resolved (see buildContinueMessage) so
        // the user doesn't have to type a follow-up just to unstick an
        // agent that's sitting there newly-authorized but idle — but not
        // before, so a still-pending sibling row isn't raced against an
        // early retry.
        if (event.autoContinue && event.chatId) {
          const chat = getChat(event.chatId);
          if (chat) {
            const members = chat.memberAgentIds
              .map((id) => (id === agent.id ? agent : getAgent(id)))
              .filter(Boolean);
            const outcomes = Array.isArray(event.outcomes) && event.outcomes.length
              ? event.outcomes
              : [{ toolName: event.toolName, value: event.value, granted: true }];
            await runAgentsParallel([agent], members, chat, buildContinueMessage(outcomes), wss);
          }
        }
        break;
      }
      case 'DENY_PERMISSION': {
        // { type: 'DENY_PERMISSION', agentId: string, chatId?: string, toolName: string,
        //   value: string, autoContinue: boolean, outcomes?: PermissionOutcome[] }
        // Unlike GRANT_PERMISSION, nothing is persisted — a denial is
        // already the agent's default state, there's no stored permission
        // to revoke. So there's nothing at all to do here until every row
        // in the card is resolved: only then does this auto-continue the
        // agent's turn, informed of every outcome (see buildContinueMessage).
        if (!event.autoContinue || !event.chatId) break;
        // A sibling row's grant may still be being applied; the retry has
        // to run after it — see withPermissionLock.
        await withPermissionLock(event.agentId, async () => {});
        const agent = getAgent(event.agentId);
        const chat = getChat(event.chatId);
        if (!agent || !chat) break;
        const members = chat.memberAgentIds.map((id) => getAgent(id)).filter(Boolean);
        const outcomes = Array.isArray(event.outcomes) && event.outcomes.length
          ? event.outcomes
          : [{ toolName: event.toolName, value: event.value, granted: false }];
        await runAgentsParallel([agent], members, chat, buildContinueMessage(outcomes), wss);
        break;
      }
      case 'STOP_AGENT': {
        // { type: 'STOP_AGENT', streamId: string }
        // A no-op if the stream already finished (or never existed) —
        // activeStreams only holds entries for turns still in flight.
        activeStreams.get(event.streamId)?.controller.abort();
        break;
      }
      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;
    }
  });

  ws.on('error', (err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Catch this one newly-connected client up on any turn already in flight
  // — see buildActiveStreamSnapshot's docs for why: without this, a page
  // refresh (or first load) while an agent is mid-turn showed nothing at
  // all until the turn finished, indistinguishable from the request having
  // silently gone nowhere. Sent directly to this socket, not broadcast —
  // every other connected client already has these streams live.
  for (const snapshot of buildActiveStreamSnapshot()) {
    ws.send(JSON.stringify(snapshot));
  }
  // Same catch-up for agents waiting on a background task between turns.
  for (const { agentId, tasks } of getAllBackgroundTasks()) {
    ws.send(JSON.stringify({ type: 'AGENT_BACKGROUND_TASKS', agentId, tasks }));
  }
}
