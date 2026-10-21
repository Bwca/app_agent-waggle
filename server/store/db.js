/**
 * @fileoverview SQLite-based persistence layer (node:sqlite, Node's built-in
 * driver — no native compile step, so no node-gyp/Visual Studio/build-essential
 * required on any platform).
 * Opens/creates the database on startup; if a legacy data.json exists and no
 * database file exists yet, imports it once. All writes are synchronous
 * SQLite statements wrapped in `async` functions to preserve the existing
 * awaited call sites.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { DEFAULT_PROVIDER_ID } from '../public/agentProviders.js';

const log = logger.child({ component: 'db' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.APP_DB_FILE ?? join(__dirname, 'data.sqlite3');
const JSON_DATA_FILE = join(__dirname, 'data.json');

/** @type {import('node:sqlite').DatabaseSync} */
let db;

/**
 * Runs `fn` inside a transaction, committing on success and rolling back if
 * it throws. node:sqlite's DatabaseSync has no built-in `.transaction()`
 * helper (unlike better-sqlite3), so this shim covers the small handful of
 * call sites in this file that need one.
 * @template T
 * @param {() => T} fn
 * @returns {() => T}
 */
function transaction(fn) {
  return () => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

/**
 * @typedef {Object} Attachment
 * @property {string} id - Client-generated UUID
 * @property {'image' | 'text'} type - Attachment kind
 * @property {string} [mediaType] - MIME type, images only (e.g. "image/png")
 * @property {string} [name] - Filename or a label like "Pasted text #1 (+40 lines)"
 * @property {string} data - Base64 (image) or raw text (text paste)
 * @property {number} [size] - Byte/char length, for display
 */

/**
 * @typedef {Object} Agent
 * @property {string} id - UUID v4
 * @property {string} name - Display name
 * @property {string} color - Hex color string e.g. "#6B8EAD"
 * @property {string} workingDir - Absolute path to the agent's project directory
 * @property {string} provider - Which CLI this agent runs as (an id from
 *   services/providers/index.js's registry, e.g. "claude"). Set at
 *   creation only: a session belongs to one CLI, so switching would strand it.
 * @property {string} [resumeId] - Optional --resume session ID for the
 *   agent's CLI (an ACP session id for opencode)
 * @property {string[]} [extraAllowedPaths] - Additional directories granted via
 *   GRANT_PERMISSION for file-path-scoped tools (Write/Edit/Read/NotebookEdit),
 *   passed to `claude` as `--add-dir`.
 * @property {string[]} [allowedToolPatterns] - Tool-permission patterns granted via
 *   GRANT_PERMISSION for non-file tools like Bash (e.g. "Bash(git add:*)"), passed
 *   to `claude` as `--allowedTools`. Kept distinct from extraAllowedPaths since
 *   `--add-dir` only ever widens filesystem access — it can't authorize a command.
 * @property {boolean} [dangerouslySkipPermissions] - "YOLO mode": spawns this agent
 *   with `--dangerously-skip-permissions` instead of the normal acceptEdits + grant
 *   flow, bypassing every permission check entirely (no denials, no cards, ever).
 *   Opt-in per agent at creation/edit time; never a default.
 * @property {boolean} [isObserver] - Never responds to a broadcast (un-@mentioned)
 *   message — only responds when explicitly @mentioned (typed, relayed, or via a
 *   scheduled message). In exchange, gets the FULL chat history as context instead
 *   of the normal recent-window cap, so a dormant observer can catch up on a whole
 *   day's work when finally asked to summarize it. Opt-in at creation only (no UI
 *   edit later, though PATCH supports it generically). Purely server-side routing/
 *   context logic — does not affect CLI spawn args at all.
 * @property {boolean} [chromeAccess] - Spawns this agent with `--chrome`, enabling
 *   the Claude in Chrome browser-automation MCP tools. Multiple agents may hold
 *   this concurrently — the extension's local bridge scopes each connecting CLI
 *   process to its own tab group, so no app-wide singleton is needed. Opt-in at
 *   creation only (no UI edit later, though PATCH supports it generically).
 * @property {string} [note] - Freeform text set by the user, purely a reminder of
 *   why this agent was created / what it's for — never sent to the CLI or the
 *   agent itself. Editable any time (unlike isObserver/chromeAccess) since it
 *   carries no spawn-arg implications, so changing it never evicts the running
 *   process.
 * @property {string} [model] - The real model ID the CLI reported actually
 *   running this agent's most recent turn (e.g. "claude-sonnet-5"), captured
 *   from that turn's own stream-json `assistant` events — see
 *   providers/claude.js's createTurnAccumulator. Purely observational —
 *   read-only from this app's own perspective, never written by a user
 *   action — reflecting whatever the CLI actually ran on, whether that's its
 *   own default resolution or `modelOverride` below. Undefined until the
 *   agent has completed at least one real (non-local-command, non-synthetic)
 *   turn.
 * @property {string} [modelOverride] - User-requested model for this agent's
 *   session, passed to the CLI as `--model <modelOverride>` (an alias like
 *   "opus"/"sonnet"/"fable", or a full model ID — same values the CLI's own
 *   `--model` flag accepts). Undefined means "let the CLI decide on its
 *   own", the default for every agent. Baked into spawn args like
 *   workingDir/resumeId/chromeAccess — confirmed empirically that pairing it
 *   with `--resume` genuinely switches the model an existing session runs on
 *   without losing conversation context (the CLI reports a
 *   `cache_miss_reason: "model_changed"` on that turn — prompt caching is
 *   model-specific, so a switch costs a one-time full cache rebuild, not a
 *   fresh conversation) — so changing it must evict the running process the
 *   same way those do (see PATCH /api/agents/:id's flagsChanged).
 * @property {string} [autocompactOverride] - This agent's own context-compaction
 *   window, passed to the CLI as `--autocompact` (see normalizeAutocompact in
 *   public/autocompact.js for the accepted values). Undefined means "use the
 *   default from Settings" (getDefaultAutocompact). Baked into spawn args
 *   like modelOverride, so changing it evicts the running process; the next
 *   turn resumes the same session with the new window.
 * @property {number} cumulativeCostUsd - Running total of the CLI's own
 *   `total_cost_usd` across every turn this agent has EVER run (successful
 *   or errored — an errored turn, e.g. a session-limit failure, still spent
 *   real money before it hit the wall) — this is a lifetime total for the
 *   agent record itself, NOT scoped to its current chat: it keeps
 *   accumulating across a remove-from-one-chat/add-to-another move (only
 *   `resumeId` gets cleared on that, see the chat_members unique index
 *   docs), so it can include spend from turns run in a chat this agent no
 *   longer belongs to. Never resets on its own; 0 for a brand-new agent.
 *   Purely informational, shown in the agent panel so a long-running
 *   agent's actual spend is visible instead of only ever showing up in the
 *   log file after the fact — the UI must label it as all-time/all-chats
 *   (not "this chat") so it isn't misread as a per-conversation cost.
 * @property {number} [lastTurnCostUsd] - The CLI's own `total_cost_usd` for
 *   just this agent's most recent turn (overwritten each turn, unlike
 *   cumulativeCostUsd which only ever grows) — the number that answers "why
 *   did the all-time total just jump," shown alongside it in the agent
 *   panel. Undefined until the agent's first real turn.
 * @property {number} [lastContextTokens] - The session's context size (input +
 *   cache-creation + cache-read tokens) as of the last model request of
 *   this agent's most recent turn that made one — i.e. what every request
 *   in its next turn will have to read back, before any new output.
 *   Undefined until the first real turn. See createTurnAccumulator's
 *   contextTokens docs (providers/index.js) for why it isn't the
 *   `result` event's summed totals.
 *   The number that answers "is this session's cache big enough that I
 *   should consider starting fresh (remove + re-add the agent) instead of
 *   letting it keep growing?" — see --autocompact in
 *   providers/claude.js's buildArgs for the automatic mitigation, and
 *   this field for the manual decision.
 * @property {string} [sessionLimitResetAt] - ISO 8601 instant when Claude's
 *   own session-limit message (e.g. "You've hit your session limit · resets
 *   7:20pm (Australia/Darwin)" — see services/sessionLimitReset.js) most
 *   recently said this agent's limit resets. Set on every turn error that
 *   names one, regardless of chat.autoContinue (that flag only controls
 *   whether a "please continue" gets auto-scheduled — this field is purely
 *   informational, shown in the agent panel so a still-limited agent is
 *   visible before you try prompting it again). Cleared on this agent's next
 *   successful turn.
 * @property {string} [contextResetAt] - ISO 8601 timestamp of this agent's
 *   most recent "/clear" (see commands.js's ALLOWED_BUILTIN_COMMANDS and
 *   agentProcessManager.js's conversation_reset handling), or undefined if
 *   it's never been cleared. A "/clear" rotates the underlying CLI session
 *   to a brand-new one with zero memory of anything before it — unlike a
 *   compaction, which just summarizes the SAME session. buildPromptBlocks
 *   and catchUpMessagesFor (ws/handler.js) both check this against an
 *   agent's own last chat message to know a resumed session can no longer
 *   be trusted to remember turns from before this point, the same way they
 *   already treat an agent with no resumeId at all as having zero memory.
 * @property {string} [seenUntil] - ISO 8601 instant the prompt of this
 *   agent's last completed turn in its chat was built: everything posted
 *   before it has reached the agent. ws/handler.js's catchUpMessagesFor
 *   catches the agent up from here. Undefined until its first such turn, and
 *   cleared with resumeId (leaving the chat, or a PATCH to a different
 *   session), since it describes that session's memory.
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} Chat
 * @property {string} id - UUID v4
 * @property {string} name - Chat room name
 * @property {string[]} memberAgentIds - Array of agent UUIDs in this chat
 * @property {string | null} rosterChangedAt - ISO 8601 timestamp of the last
 *   membership change (add or remove), or null if it's never changed since
 *   creation. Used to decide whether an already-spoken agent needs a fresh
 *   roster note even when nothing else happened since its last turn — see
 *   buildPromptBlocks in ws/handler.js.
 * @property {boolean} freeRelay - When true, the agent-to-agent delegation
 *   relay (an agent's reply `@mentioning` a teammate — see
 *   extractMentionedAgents/handleUserMessage in ws/handler.js) is NOT
 *   depth-capped at one hop: the same agent can be relayed repeatedly across
 *   rounds, up to the safety ceiling (FREE_RELAY_MAX_ROUNDS in
 *   ws/handler.js), so members of this chat can carry on an extended
 *   back-and-forth without the user re-prompting each hop. Defaults to
 *   false (the original single-hop-only behavior) for every other chat.
 * @property {boolean} autoContinue - When true, an agent turn that errors
 *   out on Claude's own session-limit message (e.g. "You've hit your
 *   session limit · resets 7:20pm (Australia/Darwin)" — see
 *   services/sessionLimitReset.js and the catch block in
 *   runAgentsParallel/ws/handler.js) gets a scheduled message auto-armed for
 *   one minute after that reset time, nudging just that agent to continue
 *   without the user having to notice the limit cleared and say so
 *   themselves. Defaults to false for every other chat.
 * @property {string | null} category - Freeform label for grouping chats in
 *   the sidebar (e.g. "Work", "Personal"), or null if uncategorized. Purely
 *   organizational — never sent to agents or referenced in ws/handler.js.
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {'user' | 'agent'} MessageRole
 */

/**
 * @typedef {Object} Message
 * @property {string} id - UUID v4
 * @property {string} chatId - Parent chat UUID
 * @property {MessageRole} role - Who authored this message
 * @property {string | null} agentId - Agent UUID if role === 'agent', else null
 * @property {string} authorName - Display name of the author
 * @property {string} content - Full message text
 * @property {Attachment[]} attachments - Images/large text pastes attached to this message
 * @property {import('../services/agentProcessManager.js').ToolCall[]} toolCalls - Tool
 *   calls made while producing this message (agent messages only — always
 *   `[]` for user messages), each paired with its own result.
 * @property {boolean} [isLocalCommandOnly] - True when this agent reply came
 *   entirely from the `claude` CLI's OWN local-command dispatcher (e.g. a
 *   bare "/chrome", "/help" — its built-in commands, not this project's
 *   `.claude/commands/*.md` skills) intercepting the turn before the model
 *   ever saw it — see agentProcessManager.js's local_command handling.
 *   Still shown in the chat like any other reply, but excluded from
 *   hasSpokenInChat/catch-up reasoning in ws/handler.js: nothing sent
 *   alongside it (the [System] preamble, any catch-up context) actually
 *   reached the model, so treating it as a real turn would permanently
 *   skip the agent's one-time introduction.
 * @property {boolean} [isSystemNote] - True for an informational note about
 *   the agent itself (currently just a context-compaction report — see
 *   agentProcessManager.js's compact_boundary handling) rather than
 *   something the agent actually said. Rendered distinctly (no avatar
 *   bubble) in the frontend — see buildMessageEl in app.js. Excluded from
 *   catch-up/hasSpokenInChat reasoning the same way isLocalCommandOnly is,
 *   for the same reason: nothing here ever reached the model as a real turn.
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} ScheduledMessage
 * @property {string} id - UUID v4
 * @property {string} chatId - Target chat UUID
 * @property {string} content - Message text to send once it fires
 * @property {Attachment[]} attachments - Attachments to send along with it
 * @property {string} sendAt - ISO 8601 timestamp of when this should fire
 * @property {string} createdAt - ISO 8601 timestamp of when this was scheduled
 * @property {boolean} [isAutoContinue] - True for a "please continue" message
 *   maybeScheduleAutoContinue (ws/handler.js) created after a session-limit
 *   error, as opposed to one a user scheduled by hand via the 🕐 panel.
 *   initScheduler (services/scheduler.js) uses this to leave an overdue one
 *   un-armed at startup instead of firing it late.
 */

/**
 * @typedef {Object} QuickMessage
 * @property {string} id - UUID v4
 * @property {string} text - The saved message text, inserted into the
 *   composer (not auto-sent) when picked — a canned reply for something
 *   typed often (e.g. "Please continue", a standing instruction), global
 *   across every chat rather than per-chat, since the whole point is not
 *   having to re-type it regardless of which chat you're in.
 * @property {string} createdAt - ISO 8601 timestamp
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER_ID}',
  resume_id TEXT,
  extra_allowed_paths TEXT NOT NULL DEFAULT '[]',
  allowed_tool_patterns TEXT NOT NULL DEFAULT '[]',
  dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0,
  is_observer INTEGER NOT NULL DEFAULT 0,
  chrome_access INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  last_known_model TEXT,
  model_override TEXT,
  autocompact_override TEXT,
  cumulative_cost_usd REAL NOT NULL DEFAULT 0,
  last_turn_cost_usd REAL,
  last_context_tokens INTEGER,
  session_limit_reset_at TEXT,
  context_reset_at TEXT,
  seen_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roster_changed_at TEXT,
  free_relay INTEGER NOT NULL DEFAULT 0,
  auto_continue INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, agent_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  is_local_command_only INTEGER NOT NULL DEFAULT 0,
  is_system_note INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  send_at TEXT NOT NULL,
  is_auto_continue INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_send_at ON scheduled_messages(send_at);

CREATE TABLE IF NOT EXISTS quick_messages (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Rebuilds the `messages` table if it still has the original agent_id
 * foreign key (no ON DELETE action), which blocked deleting an agent who'd
 * ever sent a message — `CREATE TABLE IF NOT EXISTS` in SCHEMA only applies
 * to brand-new databases, so existing ones need this one-time migration.
 * Preserves all rows; a no-op (one cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateMessagesAgentFk() {
  const agentFk = db.prepare("PRAGMA foreign_key_list(messages)").all()
    .find((fk) => fk.table === 'agents' && fk.from === 'agent_id');
  if (!agentFk || agentFk.on_delete === 'SET NULL') return;

  db.exec('PRAGMA foreign_keys = OFF');
  transaction(() => {
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','agent')),
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO messages_new (id, chat_id, role, agent_id, author_name, content, attachments, created_at)
      SELECT id, chat_id, role, agent_id, author_name, content, attachments, created_at FROM messages
    `);
    db.exec('DROP TABLE messages');
    db.exec('ALTER TABLE messages_new RENAME TO messages');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)');
  })();
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Adds the `allowed_tool_patterns` column to `agents` if it's missing — needed
 * for any database created before this column existed, since `CREATE TABLE IF
 * NOT EXISTS` in SCHEMA only applies to brand-new databases. A no-op (one
 * cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateAgentsAllowedToolPatterns() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'allowed_tool_patterns');
  if (hasColumn) return;
  db.exec("ALTER TABLE agents ADD COLUMN allowed_tool_patterns TEXT NOT NULL DEFAULT '[]'");
}

/**
 * Adds the `dangerously_skip_permissions` column to `agents` if it's missing,
 * same reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsDangerMode() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'dangerously_skip_permissions');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `is_observer` column to `agents` if it's missing, same reasoning
 * as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsObserverMode() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'is_observer');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN is_observer INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `chrome_access` column to `agents` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsChromeAccess() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'chrome_access');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN chrome_access INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `note` column to `agents` if it's missing, same reasoning as
 * migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsNote() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'note');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN note TEXT');
}

/**
 * Adds the `last_known_model` column to `agents` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsLastKnownModel() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'last_known_model');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN last_known_model TEXT');
}

/**
 * Adds the `model_override` column to `agents` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsModelOverride() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'model_override');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN model_override TEXT');
}

/**
 * Adds the `autocompact_override` column to `agents` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsAutocompactOverride() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'autocompact_override');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN autocompact_override TEXT');
}

/**
 * Adds the `provider` column to `agents` if it's missing, same reasoning as
 * migrateAgentsAllowedToolPatterns above. Every agent from before it existed
 * ran as Claude, the default.
 * @returns {void}
 */
function migrateAgentsProvider() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'provider');
  if (hasColumn) return;
  db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER_ID}'`);
}

/**
 * Adds the `cumulative_cost_usd` and `last_context_tokens` columns to
 * `agents` if missing, same reasoning as migrateAgentsAllowedToolPatterns
 * above. cumulative_cost_usd defaults to 0 (matching the column default)
 * rather than NULL, since every agent — even one pre-dating this migration
 * — has spent $0 as far as this app has ever recorded.
 * @returns {void}
 */
function migrateAgentsUsageStats() {
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((col) => col.name);
  if (!columns.includes('cumulative_cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN cumulative_cost_usd REAL NOT NULL DEFAULT 0');
  }
  if (!columns.includes('last_context_tokens')) {
    db.exec('ALTER TABLE agents ADD COLUMN last_context_tokens INTEGER');
  }
}

/**
 * Adds the `last_turn_cost_usd` column to `agents` if it's missing, same
 * reasoning as migrateAgentsUsageStats above. Left NULL (not 0) for a
 * pre-existing agent — unlike cumulative_cost_usd, "$0 for the last turn"
 * would be a false claim about a turn this app never actually measured.
 * @returns {void}
 */
function migrateAgentsLastTurnCost() {
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((col) => col.name);
  if (!columns.includes('last_turn_cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN last_turn_cost_usd REAL');
  }
}

/**
 * Adds the `session_limit_reset_at` column to `agents` if it's missing,
 * same reasoning as migrateAgentsUsageStats above.
 * @returns {void}
 */
function migrateAgentsSessionLimitReset() {
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((col) => col.name);
  if (!columns.includes('session_limit_reset_at')) {
    db.exec('ALTER TABLE agents ADD COLUMN session_limit_reset_at TEXT');
  }
}

/**
 * Adds the `context_reset_at` column to `agents` if it's missing, same
 * reasoning as migrateAgentsUsageStats above.
 * @returns {void}
 */
function migrateAgentsContextResetAt() {
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((col) => col.name);
  if (!columns.includes('context_reset_at')) {
    db.exec('ALTER TABLE agents ADD COLUMN context_reset_at TEXT');
  }
}

/**
 * Adds the `seen_until` column to `agents` if it's missing, same reasoning
 * as migrateAgentsUsageStats above.
 * @returns {void}
 */
function migrateAgentsSeenUntil() {
  const columns = db.prepare("PRAGMA table_info(agents)").all().map((col) => col.name);
  if (!columns.includes('seen_until')) {
    db.exec('ALTER TABLE agents ADD COLUMN seen_until TEXT');
  }
}

/**
 * Adds the `tool_calls` column to `messages` if it's missing — needed for
 * any database created before this column existed, since `CREATE TABLE IF
 * NOT EXISTS` in SCHEMA only applies to brand-new databases. A no-op (one
 * cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateMessagesToolCalls() {
  const hasColumn = db.prepare("PRAGMA table_info(messages)").all()
    .some((col) => col.name === 'tool_calls');
  if (hasColumn) return;
  db.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT NOT NULL DEFAULT '[]'");
}

/**
 * Adds the `is_local_command_only` column to `messages` if it's missing,
 * same reasoning as migrateMessagesToolCalls above.
 * @returns {void}
 */
function migrateMessagesLocalCommandOnly() {
  const hasColumn = db.prepare("PRAGMA table_info(messages)").all()
    .some((col) => col.name === 'is_local_command_only');
  if (hasColumn) return;
  db.exec('ALTER TABLE messages ADD COLUMN is_local_command_only INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `is_system_note` column to `messages` if it's missing, same
 * reasoning as migrateMessagesToolCalls above.
 * @returns {void}
 */
function migrateMessagesSystemNote() {
  const hasColumn = db.prepare("PRAGMA table_info(messages)").all()
    .some((col) => col.name === 'is_system_note');
  if (hasColumn) return;
  db.exec('ALTER TABLE messages ADD COLUMN is_system_note INTEGER NOT NULL DEFAULT 0');
}

/**
 * Enforces "each agent belongs to at most one chat at a time" via a UNIQUE
 * index on chat_members.agent_id — an agent's resumeId is a single global
 * Claude session, so being in 2+ chats simultaneously would bleed one
 * chat's conversation into another's. Unlike migrateMessagesAgentFk, no
 * table rebuild is needed here — SQLite can add an index to an existing
 * table directly. Deliberately NOT declared in SCHEMA itself: db.exec(SCHEMA)
 * runs unconditionally on every startup (not just for brand-new databases),
 * so if an existing DB ever had a real duplicate membership, building the
 * index there would throw before this migration's dedup step ever ran.
 *
 * If any agent already has memberships in 2+ chats (verified zero cases on
 * this app's live DB — this is defensive, not an urgent fix), keeps the
 * earliest membership (lowest rowid) and drops the rest, logging each drop.
 * Confirmed via a throwaway script (fresh DB, simulated legacy DB with a
 * real duplicate, and a reopen-after-migration check) that this is a clean,
 * idempotent no-op once the index exists.
 * @returns {void}
 */
function migrateChatMembersUniqueAgent() {
  const hasIndex = db.prepare('PRAGMA index_list(chat_members)').all()
    .some((idx) => idx.name === 'idx_chat_members_agent' && idx.unique);
  if (hasIndex) return;

  const dupes = db.prepare(`
    SELECT chat_id, agent_id, rowid FROM chat_members
    WHERE rowid NOT IN (SELECT MIN(rowid) FROM chat_members GROUP BY agent_id)
  `).all();
  for (const row of dupes) {
    log.warn({ agentId: row.agent_id, chatId: row.chat_id }, 'migration: dropping extra chat membership (keeping earliest only)');
    db.prepare('DELETE FROM chat_members WHERE rowid = ?').run(row.rowid);
  }
  db.exec('CREATE UNIQUE INDEX idx_chat_members_agent ON chat_members(agent_id)');
}

/**
 * Adds the `roster_changed_at` column to `chats` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateChatsRosterChangedAt() {
  const hasColumn = db.prepare("PRAGMA table_info(chats)").all()
    .some((col) => col.name === 'roster_changed_at');
  if (hasColumn) return;
  db.exec('ALTER TABLE chats ADD COLUMN roster_changed_at TEXT');
}

/**
 * Adds the `free_relay` column to `chats` if it's missing, same reasoning
 * as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateChatsFreeRelay() {
  const hasColumn = db.prepare("PRAGMA table_info(chats)").all()
    .some((col) => col.name === 'free_relay');
  if (hasColumn) return;
  db.exec('ALTER TABLE chats ADD COLUMN free_relay INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `auto_continue` column to `chats` if it's missing, same reasoning
 * as migrateChatsFreeRelay above.
 * @returns {void}
 */
function migrateChatsAutoContinue() {
  const hasColumn = db.prepare("PRAGMA table_info(chats)").all()
    .some((col) => col.name === 'auto_continue');
  if (hasColumn) return;
  db.exec('ALTER TABLE chats ADD COLUMN auto_continue INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `category` column to `chats` if it's missing, same reasoning as
 * migrateChatsRosterChangedAt above.
 * @returns {void}
 */
function migrateChatsCategory() {
  const hasColumn = db.prepare("PRAGMA table_info(chats)").all()
    .some((col) => col.name === 'category');
  if (hasColumn) return;
  db.exec('ALTER TABLE chats ADD COLUMN category TEXT');
}

/**
 * Adds the `is_auto_continue` column to `scheduled_messages` if it's
 * missing, same reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateScheduledMessagesAutoContinue() {
  const hasColumn = db.prepare("PRAGMA table_info(scheduled_messages)").all()
    .some((col) => col.name === 'is_auto_continue');
  if (hasColumn) return;
  db.exec('ALTER TABLE scheduled_messages ADD COLUMN is_auto_continue INTEGER NOT NULL DEFAULT 0');
}

/**
 * Maps a raw `agents` row to the public Agent shape.
 * @param {Record<string, unknown>} row
 * @returns {Agent}
 */
function rowToAgent(row) {
  const extraAllowedPaths = JSON.parse(row.extra_allowed_paths);
  const allowedToolPatterns = JSON.parse(row.allowed_tool_patterns);
  const agent = {
    id: row.id,
    name: row.name,
    color: row.color,
    workingDir: row.working_dir,
    provider: row.provider,
    createdAt: row.created_at,
  };
  if (row.resume_id) agent.resumeId = row.resume_id;
  if (extraAllowedPaths.length) agent.extraAllowedPaths = extraAllowedPaths;
  if (allowedToolPatterns.length) agent.allowedToolPatterns = allowedToolPatterns;
  if (row.dangerously_skip_permissions) agent.dangerouslySkipPermissions = true;
  if (row.is_observer) agent.isObserver = true;
  if (row.chrome_access) agent.chromeAccess = true;
  if (row.note) agent.note = row.note;
  if (row.last_known_model) agent.model = row.last_known_model;
  if (row.model_override) agent.modelOverride = row.model_override;
  if (row.autocompact_override) agent.autocompactOverride = row.autocompact_override;
  agent.cumulativeCostUsd = row.cumulative_cost_usd;
  if (row.last_turn_cost_usd != null) agent.lastTurnCostUsd = row.last_turn_cost_usd;
  if (row.last_context_tokens != null) agent.lastContextTokens = row.last_context_tokens;
  if (row.session_limit_reset_at) agent.sessionLimitResetAt = row.session_limit_reset_at;
  if (row.context_reset_at) agent.contextResetAt = row.context_reset_at;
  if (row.seen_until) agent.seenUntil = row.seen_until;
  return agent;
}

/**
 * Maps a raw `chats` row (plus its member IDs) to the public Chat shape.
 * @param {Record<string, unknown>} row
 * @returns {Chat}
 */
function rowToChat(row) {
  const memberAgentIds = db
    .prepare('SELECT agent_id FROM chat_members WHERE chat_id = ? ORDER BY rowid')
    .all(row.id)
    .map((r) => r.agent_id);
  return { id: row.id, name: row.name, memberAgentIds, rosterChangedAt: row.roster_changed_at ?? null, freeRelay: Boolean(row.free_relay), autoContinue: Boolean(row.auto_continue), category: row.category ?? null, createdAt: row.created_at };
}

/**
 * Maps a raw `messages` row to the public Message shape.
 *
 * For user-authored rows, authorName resolves to the CURRENT display name
 * setting rather than whatever was stored at send time — the user's name is
 * a live identity, not a per-message snapshot, so renaming applies to their
 * whole message history, not just future messages. (Agent-authored rows keep
 * their stored author_name, since an agent's identity doesn't change.)
 * @param {Record<string, unknown>} row
 * @returns {Message}
 */
function rowToMessage(row) {
  const message = {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    agentId: row.agent_id,
    authorName: row.role === 'user' ? getUserDisplayName() : row.author_name,
    content: row.content,
    attachments: JSON.parse(row.attachments),
    toolCalls: JSON.parse(row.tool_calls ?? '[]'),
    createdAt: row.created_at,
  };
  if (row.is_local_command_only) message.isLocalCommandOnly = true;
  if (row.is_system_note) message.isSystemNote = true;
  return message;
}

/**
 * Maps a raw `scheduled_messages` row to the public ScheduledMessage shape.
 * @param {Record<string, unknown>} row
 * @returns {ScheduledMessage}
 */
function rowToScheduledMessage(row) {
  const msg = {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    attachments: JSON.parse(row.attachments),
    sendAt: row.send_at,
    createdAt: row.created_at,
  };
  if (row.is_auto_continue) msg.isAutoContinue = true;
  return msg;
}

/**
 * Maps a raw `quick_messages` row to the public QuickMessage shape.
 * @param {Record<string, unknown>} row
 * @returns {QuickMessage}
 */
function rowToQuickMessage(row) {
  return { id: row.id, text: row.text, createdAt: row.created_at };
}

/**
 * Imports a legacy data.json into the freshly-created SQLite schema, once.
 * @returns {void}
 */
function importLegacyJson() {
  const raw = JSON.parse(readFileSync(JSON_DATA_FILE, 'utf-8'));
  const insertAgent = db.prepare(`
    INSERT INTO agents (id, name, color, working_dir, resume_id, extra_allowed_paths, allowed_tool_patterns, dangerously_skip_permissions, is_observer, chrome_access, note, created_at)
    VALUES (@id, @name, @color, @workingDir, @resumeId, @extraAllowedPaths, @allowedToolPatterns, @dangerouslySkipPermissions, @isObserver, @chromeAccess, @note, @createdAt)
  `);
  const insertChat = db.prepare('INSERT INTO chats (id, name, created_at) VALUES (?, ?, ?)');
  const insertMember = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)');
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, chat_id, role, agent_id, author_name, content, attachments, created_at)
    VALUES (@id, @chatId, @role, @agentId, @authorName, @content, @attachments, @createdAt)
  `);

  const importTxn = transaction(() => {
    for (const a of raw.agents ?? []) {
      insertAgent.run({
        id: a.id,
        name: a.name,
        color: a.color,
        workingDir: a.workingDir,
        resumeId: a.resumeId ?? null,
        extraAllowedPaths: JSON.stringify(a.extraAllowedPaths ?? []),
        allowedToolPatterns: JSON.stringify(a.allowedToolPatterns ?? []),
        dangerouslySkipPermissions: a.dangerouslySkipPermissions ? 1 : 0,
        isObserver: a.isObserver ? 1 : 0,
        chromeAccess: a.chromeAccess ? 1 : 0,
        note: a.note ?? null,
        createdAt: a.createdAt,
      });
    }
    for (const c of raw.chats ?? []) {
      insertChat.run(c.id, c.name, c.createdAt);
      for (const agentId of c.memberAgentIds ?? []) insertMember.run(c.id, agentId);
    }
    for (const m of raw.messages ?? []) {
      insertMessage.run({
        id: m.id,
        chatId: m.chatId,
        role: m.role,
        agentId: m.agentId ?? null,
        authorName: m.authorName,
        content: m.content,
        attachments: JSON.stringify(m.attachments ?? []),
        createdAt: m.createdAt,
      });
    }
  });
  importTxn();
}

/**
 * Opens (or creates) the database, applies the schema, and imports a legacy
 * data.json exactly once if the database file didn't already exist.
 * @returns {Promise<void>}
 */
export async function loadDb() {
  const isMemory = DATA_FILE === ':memory:';
  const isNewDatabase = isMemory || !existsSync(DATA_FILE);

  db = new DatabaseSync(DATA_FILE);
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrateMessagesAgentFk();
  migrateMessagesToolCalls();
  migrateMessagesLocalCommandOnly();
  migrateMessagesSystemNote();
  migrateAgentsAllowedToolPatterns();
  migrateAgentsDangerMode();
  migrateAgentsObserverMode();
  migrateAgentsChromeAccess();
  migrateAgentsNote();
  migrateAgentsLastKnownModel();
  migrateAgentsModelOverride();
  migrateAgentsAutocompactOverride();
  migrateAgentsProvider();
  migrateAgentsUsageStats();
  migrateAgentsLastTurnCost();
  migrateAgentsSessionLimitReset();
  migrateAgentsContextResetAt();
  migrateAgentsSeenUntil();
  migrateChatMembersUniqueAgent();
  migrateChatsRosterChangedAt();
  migrateChatsFreeRelay();
  migrateChatsAutoContinue();
  migrateChatsCategory();
  migrateScheduledMessagesAutoContinue();

  if (!isMemory && isNewDatabase && existsSync(JSON_DATA_FILE)) {
    importLegacyJson();
  }
}

// ─── Agents ────────────────────────────────────────────────────────────────

/**
 * Returns all agents.
 * @returns {Agent[]}
 */
export function getAgents() {
  return db.prepare('SELECT * FROM agents').all().map(rowToAgent);
}

/**
 * Returns a single agent by ID, or undefined if not found.
 * @param {string} id
 * @returns {Agent | undefined}
 */
export function getAgent(id) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? rowToAgent(row) : undefined;
}

/**
 * Creates and persists a new agent.
 * @param {Omit<Agent, 'createdAt' | 'provider'> & { provider?: string }} data - provider
 *   defaults to DEFAULT_PROVIDER_ID.
 * @returns {Promise<Agent>}
 */
export async function createAgent(data) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, color, working_dir, provider, resume_id, extra_allowed_paths, allowed_tool_patterns, dangerously_skip_permissions, is_observer, chrome_access, note, model_override, autocompact_override, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id, data.name, data.color, data.workingDir, data.provider ?? DEFAULT_PROVIDER_ID,
    data.resumeId ?? null, JSON.stringify(data.extraAllowedPaths ?? []),
    JSON.stringify(data.allowedToolPatterns ?? []), data.dangerouslySkipPermissions ? 1 : 0,
    data.isObserver ? 1 : 0, data.chromeAccess ? 1 : 0, data.note ?? null, data.modelOverride ?? null, data.autocompactOverride ?? null, createdAt
  );
  return getAgent(data.id);
}

/**
 * Updates an existing agent's mutable fields and persists.
 * Only the fields present (and not undefined) in `updates` are written —
 * a partial PATCH never clobbers untouched columns.
 * @param {string} id
 * @param {Partial<Pick<Agent, 'name' | 'color' | 'workingDir' | 'resumeId' | 'extraAllowedPaths' | 'allowedToolPatterns' | 'dangerouslySkipPermissions' | 'isObserver' | 'chromeAccess' | 'note' | 'modelOverride' | 'autocompactOverride'>>} updates
 * @returns {Promise<Agent | null>}
 */
export async function updateAgent(id, updates) {
  const existing = getAgent(id);
  if (!existing) return null;

  const columns = {
    name: updates.name,
    color: updates.color,
    working_dir: updates.workingDir,
    resume_id: updates.resumeId,
    extra_allowed_paths: updates.extraAllowedPaths ? JSON.stringify(updates.extraAllowedPaths) : undefined,
    allowed_tool_patterns: updates.allowedToolPatterns ? JSON.stringify(updates.allowedToolPatterns) : undefined,
    // Boolean, so explicitly checked against undefined — unlike the arrays
    // above, `false` is a meaningful, common value here (turning YOLO mode
    // back off), not "absent".
    dangerously_skip_permissions: updates.dangerouslySkipPermissions !== undefined
      ? (updates.dangerouslySkipPermissions ? 1 : 0)
      : undefined,
    // Same explicit-undefined-check reasoning as dangerously_skip_permissions above.
    is_observer: updates.isObserver !== undefined ? (updates.isObserver ? 1 : 0) : undefined,
    // Same explicit-undefined-check reasoning as dangerously_skip_permissions above.
    chrome_access: updates.chromeAccess !== undefined ? (updates.chromeAccess ? 1 : 0) : undefined,
    note: updates.note,
    model_override: updates.modelOverride,
    autocompact_override: updates.autocompactOverride,
    // A different session doesn't remember what the old one saw.
    seen_until: updates.resumeId !== undefined && updates.resumeId !== existing.resumeId ? null : undefined,
  };
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getAgent(id);

  const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE agents SET ${setClause} WHERE id = ?`).run(...values, id);
  return getAgent(id);
}

/**
 * Sets an agent's resumeId, but only if it isn't already set — used to persist
 * an auto-captured Claude session id exactly once, safely under concurrent turns.
 * @param {string} id
 * @param {string} resumeId
 * @returns {Promise<Agent | null>} the updated agent, or null if it was already set (no-op) or not found
 */
export async function setAgentResumeIdIfUnset(id, resumeId) {
  const result = db.prepare('UPDATE agents SET resume_id = ? WHERE id = ? AND resume_id IS NULL').run(resumeId, id);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Records a "/clear" local command's effect: overwrites resumeId
 * unconditionally — unlike setAgentResumeIdIfUnset's "only if unset"
 * semantics, a "/clear" always starts a genuinely NEW CLI session,
 * replacing whatever session this agent was resuming before, so the old
 * resumeId must be discarded rather than kept. Also stamps contextResetAt
 * to now, so buildPromptBlocks/catchUpMessagesFor (ws/handler.js) know this
 * agent's live session memory doesn't extend past this point and treat its
 * next turn like a brand-new session (full system preamble + full catch-up
 * window), rather than trusting stale --resume-backed memory that no
 * longer exists on the CLI side.
 * @param {string} id
 * @param {string} resumeId - The new session_id the CLI reported once this
 *   "/clear" turn's session actually rotated (see
 *   agentProcessManager.js's conversation_reset handling).
 * @returns {Promise<Agent | null>} the updated agent, or null if not found
 */
export async function recordContextClear(id, resumeId) {
  const contextResetAt = new Date().toISOString();
  const result = db.prepare(
    'UPDATE agents SET resume_id = ?, context_reset_at = ? WHERE id = ?'
  ).run(resumeId, contextResetAt, id);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Records when the prompt of an agent's latest completed turn was built —
 * see Agent.seenUntil. Only ever moves forward: turns finish out of order
 * when one is stopped or errors, and an older build time would make the
 * agent catch up on things it has already seen.
 * @param {string} id
 * @param {string} seenUntil - ISO 8601
 * @returns {void}
 */
export function setAgentSeenUntil(id, seenUntil) {
  db.prepare('UPDATE agents SET seen_until = ? WHERE id = ? AND (seen_until IS NULL OR seen_until < ?)').run(seenUntil, id, seenUntil);
}

/**
 * Records the real model ID a turn actually ran on, overwriting whatever
 * was stored before — unlike resumeId (captured once and then fixed for
 * the life of the session), the model isn't pinned by this app (no
 * `--model` spawn flag) and can genuinely change between turns (a CLI
 * config edit, an account-side fallback), so every turn's report should
 * win over the last one rather than only being captured the first time.
 * @param {string} id
 * @param {string} model
 * @returns {Promise<Agent | null>} the updated agent, or null if the model
 *   was already exactly this (no-op, no AGENT_UPDATED needed) or the agent
 *   wasn't found
 */
export async function setAgentModel(id, model) {
  const result = db.prepare('UPDATE agents SET last_known_model = ? WHERE id = ? AND last_known_model IS NOT ?').run(model, id, model);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Records one turn's cost/context accounting: adds to the agent's running
 * cumulativeCostUsd (never reset, all-time across every chat this agent has
 * ever been part of — see its docs) and overwrites both lastTurnCostUsd and
 * lastContextTokens (only the most recent turn matters for either — see
 * their docs). A null contextTokens (a turn that errored before making any
 * model request, e.g. an immediate session-limit rejection) keeps the
 * previous value instead of wiping it, since the session's context didn't
 * change. Called for both a completed AND an errored turn, since an
 * errored one (e.g. a session-limit failure) still spent real tokens before
 * hitting the wall — same reasoning as the 'turn errored' log line in
 * ws/handler.js already capturing usage off the Error object.
 * @param {string} id
 * @param {{ totalCostUsd: number | null, contextTokens: number | null }} usage
 * @returns {Promise<Agent | null>} the updated agent, or null if not found
 */
export async function setAgentUsage(id, { totalCostUsd, contextTokens }) {
  const result = db.prepare(`
    UPDATE agents SET cumulative_cost_usd = cumulative_cost_usd + ?, last_turn_cost_usd = ?, last_context_tokens = COALESCE(?, last_context_tokens) WHERE id = ?
  `).run(totalCostUsd ?? 0, totalCostUsd ?? null, contextTokens ?? null, id);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Sets or clears sessionLimitResetAt — see its docs on the Agent typedef.
 * `resetAt` null clears it (called on this agent's next successful turn).
 * No-op (no AGENT_UPDATED needed) if the value wouldn't actually change.
 * @param {string} id
 * @param {string | null} resetAt - ISO 8601 instant, or null to clear
 * @returns {Promise<Agent | null>} the updated agent, or null if unchanged/not found
 */
export async function setAgentSessionLimitReset(id, resetAt) {
  const result = db.prepare(
    'UPDATE agents SET session_limit_reset_at = ? WHERE id = ? AND session_limit_reset_at IS NOT ?'
  ).run(resetAt, id, resetAt);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Deletes an agent.
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false if not found
 */
export async function deleteAgent(id) {
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Adds a path to an agent's extraAllowedPaths (idempotent).
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<Agent | null>}
 */
export async function grantAgentPath(agentId, path) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const extraAllowedPaths = agent.extraAllowedPaths ?? [];
  if (!extraAllowedPaths.includes(path)) {
    extraAllowedPaths.push(path);
    db.prepare('UPDATE agents SET extra_allowed_paths = ? WHERE id = ?')
      .run(JSON.stringify(extraAllowedPaths), agentId);
  }
  return getAgent(agentId);
}

/**
 * Adds a tool-permission pattern to an agent's allowedToolPatterns (idempotent) —
 * the Bash-and-friends equivalent of grantAgentPath, passed to `claude` as
 * `--allowedTools` rather than `--add-dir` (see the Agent typedef's doc comment
 * for why these two grant mechanisms are kept separate).
 * @param {string} agentId
 * @param {string} pattern - e.g. "Bash(git add:*)"
 * @returns {Promise<Agent | null>}
 */
export async function grantAgentToolPattern(agentId, pattern) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const allowedToolPatterns = agent.allowedToolPatterns ?? [];
  if (!allowedToolPatterns.includes(pattern)) {
    allowedToolPatterns.push(pattern);
    db.prepare('UPDATE agents SET allowed_tool_patterns = ? WHERE id = ?')
      .run(JSON.stringify(allowedToolPatterns), agentId);
  }
  return getAgent(agentId);
}

// ─── Chats ─────────────────────────────────────────────────────────────────

/**
 * Returns all chats.
 * @returns {Chat[]}
 */
export function getChats() {
  return db.prepare('SELECT * FROM chats').all().map(rowToChat);
}

/**
 * Returns a single chat by ID, or undefined if not found.
 * @param {string} id
 * @returns {Chat | undefined}
 */
export function getChat(id) {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return row ? rowToChat(row) : undefined;
}

/**
 * Creates and persists a new chat.
 * @param {Omit<Chat, 'createdAt'>} data
 * @returns {Promise<Chat>}
 */
export async function createChat(data) {
  const createdAt = new Date().toISOString();
  const insertMember = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)');
  const txn = transaction(() => {
    db.prepare('INSERT INTO chats (id, name, created_at) VALUES (?, ?, ?)').run(data.id, data.name, createdAt);
    for (const agentId of data.memberAgentIds ?? []) insertMember.run(data.id, agentId);
  });
  txn();
  return getChat(data.id);
}

/**
 * Updates a chat's mutable settings (currently name, freeRelay,
 * autoContinue, and category). Unlike agent flag updates, none of these is
 * baked into any spawn args, so there's no process to evict here.
 * @param {string} id
 * @param {{ name?: string, freeRelay?: boolean, autoContinue?: boolean, category?: string | null }} updates
 * @returns {Promise<Chat | null>} the updated chat, or null if not found
 */
export async function updateChat(id, updates) {
  if (!getChat(id)) return null;

  const columns = {
    name: updates.name,
    // Boolean, so explicitly checked against undefined — `false` (turning
    // free relay back off) is a meaningful, common value, not "absent".
    free_relay: updates.freeRelay !== undefined ? (updates.freeRelay ? 1 : 0) : undefined,
    auto_continue: updates.autoContinue !== undefined ? (updates.autoContinue ? 1 : 0) : undefined,
    // Nullable string, so explicitly checked against undefined too — `null`
    // (clearing the category) is a meaningful value, not "absent".
    category: updates.category !== undefined ? updates.category : undefined,
  };
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getChat(id);

  const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE chats SET ${setClause} WHERE id = ?`).run(...values, id);
  return getChat(id);
}

/**
 * Bulk-renames (or clears, when `to` is null) a category across every chat
 * that currently has it. Backs both the sidebar's "rename category" and
 * "delete category" actions — since a category is just a string value
 * duplicated across chats rather than its own row, there's no single record
 * to rename/delete, only this batch update.
 * @param {string} from - Current category value to match
 * @param {string | null} to - New value, or null to clear the category
 * @returns {number} how many chats were affected
 */
export function renameChatCategory(from, to) {
  const result = db.prepare('UPDATE chats SET category = ? WHERE category = ?').run(to, from);
  return result.changes;
}

/**
 * Clears an agent's resumeId — called whenever an agent leaves its chat
 * (removed, or the chat itself is deleted), so a later add to a *different*
 * chat starts a fresh Claude session instead of silently carrying the old
 * chat's conversational memory forward via --resume. Deliberately distinct
 * from setAgentResumeIdIfUnset, whose "only if unset" semantics are the
 * opposite of what's needed here (this always clears, unconditionally).
 * @param {string} agentId
 * @returns {void}
 */
function clearAgentResumeId(agentId) {
  db.prepare('UPDATE agents SET resume_id = NULL, seen_until = NULL WHERE id = ?').run(agentId);
}

/**
 * Returns the ID of the chat an agent currently belongs to, or undefined if
 * it's in none. Agents belong to at most one chat at a time (enforced by
 * idx_chat_members_agent — see migrateChatMembersUniqueAgent), so this is a
 * single lookup rather than a list.
 * @param {string} agentId
 * @returns {string | undefined}
 */
export function getAgentChatId(agentId) {
  const row = db.prepare('SELECT chat_id FROM chat_members WHERE agent_id = ?').get(agentId);
  return row?.chat_id;
}

/**
 * Deletes a chat and all its messages. Also clears resumeId for every agent
 * that was a member — chat_members rows cascade-delete via FK as part of
 * the same statement, which would otherwise silently free those agents to
 * join a new chat while still carrying this deleted chat's full
 * conversational memory forward via --resume.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteChat(id) {
  const txn = transaction(() => {
    const memberIds = db.prepare('SELECT agent_id FROM chat_members WHERE chat_id = ?').all(id).map((r) => r.agent_id);
    const result = db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    if (result.changes > 0) for (const agentId of memberIds) clearAgentResumeId(agentId);
    return result.changes > 0;
  });
  return txn();
}

/**
 * Stamps a chat's rosterChangedAt to now — called whenever chat_members
 * actually gains or loses a row, so an already-spoken agent whose live
 * session missed the change (no accompanying chat message, e.g. a plain
 * member removal) can still be caught up next turn. See buildPromptBlocks
 * in ws/handler.js for the read side.
 * @param {string} chatId
 * @returns {void}
 */
function touchRosterChanged(chatId) {
  db.prepare('UPDATE chats SET roster_changed_at = ? WHERE id = ?').run(new Date().toISOString(), chatId);
}

/**
 * Adds an agent to a chat's member list (idempotent). Callers are
 * responsible for rejecting an agent that's already a member of a
 * *different* chat before calling this (see getAgentChatId) — this
 * function itself just relies on idx_chat_members_agent to reject the
 * insert at the DB level if that check is skipped.
 * @param {string} chatId
 * @param {string} agentId
 * @returns {Promise<Chat | null>}
 */
export async function addChatMember(chatId, agentId) {
  if (!getChat(chatId)) return null;
  const txn = transaction(() => {
    const result = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)').run(chatId, agentId);
    if (result.changes > 0) touchRosterChanged(chatId);
  });
  txn();
  return getChat(chatId);
}

/**
 * Removes an agent from a chat's member list, and clears its resumeId —
 * see deleteChat's doc comment for why leaving a chat must reset memory.
 * Only clears if a row was actually removed, so a no-op double-remove
 * doesn't wipe an agent's session for no reason. Same changes>0 guard for
 * the rosterChangedAt stamp (see touchRosterChanged).
 * @param {string} chatId
 * @param {string} agentId
 * @returns {Promise<Chat | null>}
 */
export async function removeChatMember(chatId, agentId) {
  if (!getChat(chatId)) return null;
  const txn = transaction(() => {
    const result = db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND agent_id = ?').run(chatId, agentId);
    if (result.changes > 0) {
      clearAgentResumeId(agentId);
      touchRosterChanged(chatId);
    }
  });
  txn();
  return getChat(chatId);
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * Returns messages for a chat, ordered by createdAt ascending.
 * @param {string} chatId
 * @param {number} [limit=50]
 * @param {string} [beforeId] - Return messages created before this message ID
 * @returns {Message[]}
 */
export function getMessages(chatId, limit = 50, beforeId) {
  let rows;
  if (beforeId) {
    const pivot = db.prepare('SELECT created_at, rowid FROM messages WHERE id = ?').get(beforeId);
    rows = pivot
      ? db.prepare(`
          SELECT * FROM messages WHERE chat_id = ?
            AND (created_at < ? OR (created_at = ? AND rowid < ?))
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(chatId, pivot.created_at, pivot.created_at, pivot.rowid, limit)
      : [];
  } else {
    rows = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(chatId, limit);
  }
  return rows.reverse().map(rowToMessage);
}

/**
 * Total message count for a chat — the denominator behind the forum-style
 * page-number pagination in getMessagesPage (see its docs and the
 * GET /api/chats/:id/messages?page=… handler in routes/chats.js).
 * @param {string} chatId
 * @returns {number}
 */
export function getMessageCount(chatId) {
  return db.prepare('SELECT COUNT(*) as n FROM messages WHERE chat_id = ?').get(chatId).n;
}

/**
 * Returns one 1-indexed page of a chat's messages, oldest-first — page 1 is
 * the oldest messages, not the most recent (the opposite of getMessages'
 * "most recent N" window). Deliberately offset-based rather than
 * cursor-based like getMessages: a page NUMBER (not "before this id") is
 * exactly what a forum-thread-style "Page 3 of 12" nav needs, and this
 * app's per-chat message volumes never get large enough for OFFSET's O(n)
 * cost to matter.
 *
 * Out-of-range pages return an empty array rather than clamping — callers
 * (the REST route) are expected to clamp against getMessageCount-derived
 * totalPages themselves, since only they know the page size being used.
 * @param {string} chatId
 * @param {number} page - 1-indexed
 * @param {number} pageSize
 * @returns {Message[]}
 */
export function getMessagesPage(chatId, page, pageSize) {
  const rows = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ?
    ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?
  `).all(chatId, pageSize, Math.max(page - 1, 0) * pageSize);
  return rows.map(rowToMessage);
}

/**
 * Escapes SQL LIKE wildcards (`%`, `_`) in user-supplied search text so
 * they're matched literally rather than as LIKE patterns — otherwise typing
 * e.g. "50%" or "foo_bar" into the search box would silently behave as a
 * wildcard search instead of a literal substring match.
 * @param {string} text
 * @returns {string}
 */
function escapeLikeWildcards(text) {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * Substring search over a chat's message history (case-insensitive, per
 * SQLite's default ASCII LIKE behavior), newest first — backs the
 * message-search UI so a long chat can be searched without first pulling
 * its entire history into the client.
 * @param {string} chatId
 * @param {string} query
 * @param {number} [limit=30]
 * @returns {Message[]}
 */
export function searchMessages(chatId, query, limit = 30) {
  const pattern = `%${escapeLikeWildcards(query)}%`;
  const rows = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND content LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(chatId, pattern, limit);
  return rows.map(rowToMessage);
}

/**
 * Returns up to `before` messages immediately preceding `messageId`, the
 * message itself, and up to `after` messages immediately following it, in
 * chronological order — used to jump straight to a search result that lives
 * outside the recently-loaded window (getMessages only ever returns the
 * tail, or a page walking backward from it).
 * @param {string} chatId
 * @param {string} messageId
 * @param {number} [before=25]
 * @param {number} [after=25]
 * @returns {Message[]}
 */
export function getMessagesAround(chatId, messageId, before = 25, after = 25) {
  const pivot = db.prepare('SELECT *, rowid FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);
  if (!pivot) return [];
  const beforeRows = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ?
      AND (created_at < ? OR (created_at = ? AND rowid < ?))
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(chatId, pivot.created_at, pivot.created_at, pivot.rowid, before);
  const afterRows = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ?
      AND (created_at > ? OR (created_at = ? AND rowid > ?))
    ORDER BY created_at ASC, rowid ASC LIMIT ?
  `).all(chatId, pivot.created_at, pivot.created_at, pivot.rowid, after);
  return [...beforeRows.reverse(), pivot, ...afterRows].map(rowToMessage);
}

/**
 * Appends a new message and persists.
 * @param {Message} message
 * @returns {Promise<Message>}
 */
export async function addMessage(message) {
  db.prepare(`
    INSERT INTO messages (id, chat_id, role, agent_id, author_name, content, attachments, tool_calls, is_local_command_only, is_system_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id, message.chatId, message.role, message.agentId, message.authorName,
    message.content, JSON.stringify(message.attachments ?? []), JSON.stringify(message.toolCalls ?? []),
    message.isLocalCommandOnly ? 1 : 0, message.isSystemNote ? 1 : 0, message.createdAt
  );
  return message;
}

// ─── Settings ──────────────────────────────────────────────────────────────

const DEFAULT_USER_DISPLAY_NAME = 'You';
const DEFAULT_USER_COLOR = '#a6adc8';
const DEFAULT_USER_LOCALE = 'en-CA';
const DEFAULT_USER_THEME = 'dark';

/**
 * Returns a raw settings value, or defaultValue if the key isn't set.
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
function getSetting(key, defaultValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || defaultValue;
}

/**
 * Inserts or updates a raw settings value.
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * Returns the user's configured display name, defaulting to "You". Used both
 * for new messages and, via rowToMessage, to resolve authorName for past
 * user-authored messages too — renaming applies retroactively.
 * @returns {string}
 */
export function getUserDisplayName() {
  return getSetting('userDisplayName', DEFAULT_USER_DISPLAY_NAME);
}

/**
 * Sets the user's display name.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function setUserDisplayName(name) {
  setSetting('userDisplayName', name);
}

/**
 * Returns the user's configured message color (hex string).
 * @returns {string}
 */
export function getUserColor() {
  return getSetting('userColor', DEFAULT_USER_COLOR);
}

/**
 * Sets the user's message color.
 * @param {string} color - Hex color string, e.g. "#a6adc8"
 * @returns {Promise<void>}
 */
export async function setUserColor(color) {
  setSetting('userColor', color);
}

/**
 * Returns the user's configured UI language, defaulting to "en-CA".
 * @returns {string}
 */
export function getUserLocale() {
  return getSetting('locale', DEFAULT_USER_LOCALE);
}

/**
 * Sets the user's UI language.
 * @param {string} locale - e.g. "en-CA" or "fr-CA"
 * @returns {Promise<void>}
 */
export async function setUserLocale(locale) {
  setSetting('locale', locale);
}

/**
 * Returns the user's configured UI theme, defaulting to "dark".
 * @returns {string}
 */
export function getUserTheme() {
  return getSetting('theme', DEFAULT_USER_THEME);
}

/**
 * Sets the user's UI theme.
 * @param {string} theme - "dark" or "light"
 * @returns {Promise<void>}
 */
export async function setUserTheme(theme) {
  setSetting('theme', theme);
}

/**
 * Returns the context-compaction window set in Settings for agents with no
 * autocompactOverride of their own, or null when none is set (the
 * provider's own fallback then applies — see providers/claude.js).
 * @returns {string | null}
 */
export function getDefaultAutocompact() {
  return getSetting('defaultAutocompact', null);
}

/**
 * Sets the default context-compaction window. An empty string clears it.
 * @param {string} value - Already normalized (see normalizeAutocompact), or ''
 * @returns {Promise<void>}
 */
export async function setDefaultAutocompact(value) {
  setSetting('defaultAutocompact', value);
}

// ─── Scheduled Messages ─────────────────────────────────────────────────────

/**
 * Returns a chat's pending scheduled messages, ordered by sendAt ascending.
 * @param {string} chatId
 * @returns {ScheduledMessage[]}
 */
export function getScheduledMessages(chatId) {
  return db.prepare('SELECT * FROM scheduled_messages WHERE chat_id = ? ORDER BY send_at ASC')
    .all(chatId).map(rowToScheduledMessage);
}

/**
 * Returns a single scheduled message by ID, or undefined if not found.
 * @param {string} id
 * @returns {ScheduledMessage | undefined}
 */
export function getScheduledMessage(id) {
  const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  return row ? rowToScheduledMessage(row) : undefined;
}

/**
 * Returns every pending scheduled message across all chats — used once at
 * server startup to re-arm in-memory timers after a restart (see
 * services/scheduler.js's initScheduler).
 * @returns {ScheduledMessage[]}
 */
export function getAllScheduledMessages() {
  return db.prepare('SELECT * FROM scheduled_messages').all().map(rowToScheduledMessage);
}

/**
 * Creates and persists a new scheduled message.
 * @param {Omit<ScheduledMessage, 'createdAt'>} data
 * @returns {Promise<ScheduledMessage>}
 */
export async function createScheduledMessage(data) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO scheduled_messages (id, chat_id, content, attachments, send_at, is_auto_continue, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.id, data.chatId, data.content, JSON.stringify(data.attachments ?? []), data.sendAt, data.isAutoContinue ? 1 : 0, createdAt);
  return rowToScheduledMessage(
    db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(data.id)
  );
}

/**
 * Updates a pending scheduled message's content, attachments, and send
 * time in place — used to reschedule/modify one before it fires. Returns
 * the updated row, or null if it no longer exists (already fired or
 * canceled out from under the request).
 * @param {string} id
 * @param {{ content: string, attachments: Attachment[], sendAt: string }} data
 * @returns {Promise<ScheduledMessage | null>}
 */
export async function updateScheduledMessage(id, data) {
  const existing = db.prepare('SELECT id FROM scheduled_messages WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare(`
    UPDATE scheduled_messages SET content = ?, attachments = ?, send_at = ? WHERE id = ?
  `).run(data.content, JSON.stringify(data.attachments ?? []), data.sendAt, id);
  return rowToScheduledMessage(
    db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id)
  );
}

/**
 * Deletes a scheduled message if it still exists, returning what was
 * deleted (or null if it was already gone — already fired, already
 * canceled, or never existed). Used for BOTH cancellation and firing, so
 * whichever happens first "wins" and the other becomes a safe no-op.
 *
 * Safe without a SQL `RETURNING` clause: node:sqlite's DatabaseSync is
 * fully synchronous, so this SELECT-then-DELETE has no `await` between the
 * two statements and nothing else can run in between on Node's single
 * thread — the same reasoning already relied on elsewhere in this file
 * (e.g. removeChatMember's changes>0 check).
 * @param {string} id
 * @returns {Promise<ScheduledMessage | null>}
 */
export async function deleteScheduledMessageIfExists(id) {
  const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  return rowToScheduledMessage(row);
}

// ─── Quick Messages ─────────────────────────────────────────────────────────

/**
 * Returns every saved quick message, oldest first (insertion order — the
 * order they were added in, matching how the panel that lists them reads
 * top to bottom).
 * @returns {QuickMessage[]}
 */
export function getQuickMessages() {
  return db.prepare('SELECT * FROM quick_messages ORDER BY created_at ASC').all().map(rowToQuickMessage);
}

/**
 * Creates and persists a new quick message.
 * @param {{ id: string, text: string }} data
 * @returns {Promise<QuickMessage>}
 */
export async function createQuickMessage(data) {
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO quick_messages (id, text, created_at) VALUES (?, ?, ?)').run(data.id, data.text, createdAt);
  return rowToQuickMessage(db.prepare('SELECT * FROM quick_messages WHERE id = ?').get(data.id));
}

/**
 * Updates a quick message's text in place, preserving its position (still
 * ordered by its original created_at). Returns null if it no longer exists.
 * @param {string} id
 * @param {string} text
 * @returns {Promise<QuickMessage | null>}
 */
export async function updateQuickMessage(id, text) {
  const result = db.prepare('UPDATE quick_messages SET text = ? WHERE id = ?').run(text, id);
  if (result.changes === 0) return null;
  return rowToQuickMessage(db.prepare('SELECT * FROM quick_messages WHERE id = ?').get(id));
}

/**
 * Deletes a quick message.
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false if not found
 */
export async function deleteQuickMessage(id) {
  const result = db.prepare('DELETE FROM quick_messages WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Maintenance ───────────────────────────────────────────────────────────

/**
 * Deletes all data from every table. Used by the /__reset test endpoint.
 * @returns {Promise<void>}
 */
export async function resetAll() {
  const txn = transaction(() => {
    db.prepare('DELETE FROM scheduled_messages').run();
    db.prepare('DELETE FROM quick_messages').run();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM chat_members').run();
    db.prepare('DELETE FROM chats').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM settings').run();
  });
  txn();
}
