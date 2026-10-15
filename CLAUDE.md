# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clauhort: a multi-agent Claude chat app. Each chat participant ("agent") is a real Claude Code CLI instance running `--print --input-format=stream-json --output-format=stream-json` in its own working directory. The user chats with one or more agents at once (like a group chat), agents can respond in parallel, delegate to each other via `@mentions`, and run real Claude Code tools/skills/MCP servers against their own project directory.

- **Backend**: Node.js (ESM, `"type": "module"`) + Express + `ws`
- **Frontend**: Plain HTML/CSS/JS in `server/public/` — ES modules, no build step, no framework
- **Persistence**: SQLite via Node's built-in `node:sqlite` (no native compile step), at `server/store/data.sqlite3` (gitignored, auto-created)
- **i18n**: `server/public/i18n/` — a small dictionary + lookup engine imported unmodified by both the browser (`server/public/`) and the server (`server/i18n/t.js`)

Requires Node 22.13+ (see `.nvmrc` — v22.13.0) and the `claude` CLI installed, authenticated, and on `PATH`.

## If you are a Claude Code instance in a multi-agent chat about this repo

If you're participating as a named agent in a Claude Code peer chat about this codebase (multiple Claude instances collaborating via `@mentions`, distinct from — but modeled on — this app's own chat feature), treat any `@YourName` occurring **anywhere** in an incoming message as a trigger to respond, not just a trailing routing line a coordinating user appended. This mirrors how the real relay mechanism in this app works: `extractMentionedAgents` in `server/services/messageRouter.js` scans the *entire* message body for `@(\w+)`, regardless of position or surrounding punctuation — a teammate's reply mentioning you mid-message is exactly as valid a trigger as a mention at the very end. Checking only the last line and missing an embedded mention is a client-side reading error, not something the platform routes around for you.

## Commit workflow

Commit early and often — don't let work pile up into one large, hard-to-review commit. As soon as a self-contained, working piece of a task is done (one function, one file, one route, one test suite), commit it before moving to the next piece, rather than batching the whole task into a single commit at the end.

- Each commit should be small and do exactly one thing — a change someone could review and understand on its own, independent of what comes before or after it.
- Prefer several narrow commits over one broad one, even within a single task (e.g. a new route, its wiring into the router, and its test can each be their own commit).
- Write commit messages that say *why*, not just what, when the reason isn't obvious from the diff itself.
- This repo's own history (`git log`) was built this way — one concern per commit, in dependency order — and later work should keep following that pattern rather than reverting to large batched commits.
- Only commit when the user asks (see the global git safety rules) — this section governs *how* to shape commits once asked, not a standing permission to commit unprompted.

## Commands

```bash
cd server && npm install && node index.js   # run the app — http://localhost:3001
npm run debug                                # + APP_TRANSCRIPT_LOG and APP_LOG_LEVEL=debug
PORT=4000 node index.js                      # different port
```

No `--watch`/auto-restart script — reported live: `node --watch` missed reloading some edited files during a manual test session (one backend file's change sat stale for several requests while others in the same edit batch picked up fine), which silently produced misleading test results. After any backend change, kill and restart the server (`pkill -f "node index.js"`, then rerun) rather than trusting a running `--watch` process picked it up.

Unit tests (plain `node:test`, pure functions, no server/CLI needed):
```bash
node --test tests/unit/                       # all unit tests
node --test tests/unit/parse-responders.test.js  # a single file
```

E2E tests (Puppeteer, drive a real running server on port 3099):
```bash
cd tests && npm install && npm test           # all suites, sequential
node --test e2e/04-messaging.test.js          # a single suite
npm test -- --grep "agent"                    # filter by name substring
```
Each E2E file starts/stops its own server instance and shares port 3099 — never pass multiple E2E files to `node --test` at once, they'll collide on the port. `tests/run.js` already runs them with `concurrency: 1` for this reason.

There is no lint/typecheck script configured (JSDoc types only, no TypeScript build).

Key env vars (see README for the full table): `PORT`, `CLAUDE_BIN` (override the `claude` binary name/path), `APP_DB_FILE` (`:memory:` in tests), `APP_LOG_DIR`, `APP_LOG_LEVEL`, `APP_TRANSCRIPT_LOG` (full per-chat prompt/response logging, off by default), `APP_AUTOCOMPACT` (per-agent `--autocompact` window, default `200k`), `MCP_AUTH_TOKEN` (enables the `/mcp` server, unset = disabled — see "MCP server" below).

## Architecture

### Request flow

`server/index.js` wires up Express (`/api/*` REST routes + static `server/public/`) and one `WebSocketServer` at `/ws`. Live chat traffic — sending a message, streaming a response, granting a permission, stopping an agent — goes over the WebSocket, handled entirely in `server/ws/handler.js`. REST routes (`server/routes/`) cover CRUD for agents/chats/settings, directory browsing, scheduled-message CRUD, and reading message history (including the paginated `GET /api/chats/:id/messages?page=N|last` used by the forum-style page nav in `app.js`, plus search and jump-to-context) — anything that's a read, or doesn't need a live agent turn, is REST rather than a WS round-trip.

### The agent process model (the core mechanism)

Each agent that's currently a member of a chat gets **one persistent `claude` child process**, kept alive across turns (`server/services/agentProcessManager.js`), rather than a fresh spawn per message. This is what lets MCP servers and other expensive-to-establish state survive between turns. Key implications when touching this code:

- CLI flags baked in at spawn time (`--add-dir`, `--dangerously-skip-permissions`/`--permission-mode`, `--allowedTools`, `--resume`) can't change on a live process — anything that changes one of these (a permission grant, a `workingDir`/YOLO/`resumeId` PATCH) must `killAgent()` the process so the *next* turn respawns fresh with updated flags and resumes via `--resume` (no memory lost).
- A process can emit output **unprompted** — the CLI's own background-task-completion feature resuming a finished turn on its own initiative (e.g. a backgrounded Bash command finishing). This is handled via `onBackgroundTurn`/`handleUnsolicitedEvent` and surfaced to clients as `AGENT_BACKGROUND_MESSAGE`, distinct from the normal `AGENT_STREAM_START/CHUNK/END` triggered by an explicit turn.
- An agent belongs to **at most one chat at a time** (enforced by a unique index in SQLite — `idx_chat_members_agent`). Leaving a chat (removed, or the chat deleted) clears its `resumeId` so a later add to a *different* chat starts a genuinely fresh session instead of bleeding context across chats.
- `agentRunner.js` is a thin, stable-contract wrapper (`runAgentStream`) around `agentProcessManager.js`'s `runTurn` — kept so call sites don't need to know about process lifecycle. It also owns permission-pattern derivation (`deriveToolPatterns`, `dedupePermissionDenials`) shared with the WS handler's `GRANT_PERMISSION`/`DENY_PERMISSION` cases.
- Every agent is spawned with `--autocompact` set to `AUTOCOMPACT_WINDOW` (`buildArgs`, default `200k`, `APP_AUTOCOMPACT` to override), so the CLI summarizes its own older context once a resumed session's cache grows large, instead of every turn paying to re-read a multi-million-token history in full — see "Context compaction and per-agent budget" below.

### Prompting a resumed CLI session correctly

Because each agent is a real resumed Claude session, re-sending full conversation history every turn would be pure duplication — the CLI already remembers its own past turns. `server/ws/handler.js` builds each turn's prompt narrowly:

- `buildSystemPreamble` (identity + roster + @mention routing rules) is sent **once**, only on an agent's first-ever turn *in this chat* — gated on whether the agent has actually spoken in this chat's history, **not** on `resumeId` being set (an agent can be created with a manually-supplied `resumeId` pointing at an unrelated session, so resumeId-gating would skip the introduction it still needs).
- `catchUpMessagesFor` sends only messages the agent doesn't already have via its own session memory — i.e. messages since its own last turn that it wasn't the author of.
- A standalone roster-refresh note goes out whenever there's catch-up content but no full preamble, so a long-dormant agent (e.g. an Observer) doesn't hold a stale membership list while reading catch-up content that references teammates it was never introduced to.
- An **Observer** agent (`agent.isObserver`) never responds to a broadcast (un-@mentioned) message, only an explicit `@mention` — but gets the *full* chat history (`OBSERVER_HISTORY_LIMIT`, not the normal ~20-message window) on the turns it does run, since it may be catching up on a whole day of chat at once.

`@mentions` are parsed by `server/services/messageRouter.js`: `parseResponders` decides who responds to a user message (broadcast to non-observers if nothing's mentioned), `extractMentionedAgents` is used both for that and for the **relay** mechanism (an agent's own reply `@mentioning` a teammate triggers that teammate), and `parseSkillInvocation` detects a message that is *entirely* `@Name /command ...` to invoke one of that agent's real Claude Code skills (listed via `server/services/commands.js`, which reads `.claude/commands/*.md` straight off the agent's `workingDir`). The relay's trigger content is always the mentioning teammate's own reply, never the original user message or a stripped skill command. By default a chat is **bounded**: relay stops after exactly one hop, and never fires back to an agent who already responded in the same chain — this is what stops even a two-agent mutual-mention from starting a loop. A chat's `freeRelay` flag (toggled per-chat via the 🔁 button in the topbar, `PATCH /api/chats/:id`) lifts that: rounds keep going, the same agent can be relayed again in a later round, for as long as each round produces new @mentions — bounded only by `FREE_RELAY_MAX_ROUNDS` in `ws/handler.js` as a safety ceiling against a genuinely unbounded two-agent back-and-forth. A reply to an auto-continue nudge (`isAutoContinue`, see below) relays exactly like any other reply. An earlier version skipped relay for it, but that silently dropped real hand-offs from agents resuming work after a reset.

### Permission flow

Agents normally run with `--permission-mode acceptEdits` (or fully unrestricted under YOLO mode, `--dangerously-skip-permissions`, opt-in per agent at creation only). A denied tool call surfaces as a permission card in the UI; granting/denying sends `GRANT_PERMISSION`/`DENY_PERMISSION` over the WS. Two distinct grant mechanisms, kept separate because they authorize different things:
- File-path tools (`Write`/`Edit`/`Read`/`NotebookEdit`) widen `extraAllowedPaths` → `--add-dir` (granting the *containing directory*, since `--add-dir` on a file path is silently a no-op).
- Everything else (`Bash`, etc.) derives `allowedToolPatterns` → `--allowedTools`, with Bash chains (`a && b`, pipes, `;`) split into one pattern per sub-command (`deriveToolPatterns`) so a multi-command denial doesn't accidentally under- or over-grant.

Since a turn already ended by the time a denial is resolved (headless mode can't retry mid-turn), granting/denying auto-sends a synthetic follow-up message once every row in a multi-denial card is resolved (`buildContinueMessage`), not before.

### Auto-continue after a session limit

A chat's `autoContinue` flag (toggled per-chat via the ⏳ button in the topbar, `PATCH /api/chats/:id`, same shape as `freeRelay` above) makes a turn error that names Claude's own session-limit reset time self-heal instead of just sitting there. `maybeScheduleAutoContinue` in `ws/handler.js` runs on every turn error in such a chat; `services/sessionLimitReset.js`'s `parseSessionLimitReset` looks for that specific "resets 7:20pm (Australia/Darwin)"-shaped substring in the error text (a silent no-op for any other kind of error — a bad `--resume` flag, a crashed process — since this runs unconditionally, not just for session-limit errors) and resolves it to a concrete instant via an `Intl.DateTimeFormat` round-trip (no date library in this project). One minute after that instant, it arms a `@Agent` "please continue" message through the exact same scheduled-message mechanism the 🕐 panel uses (visible there, cancelable, survives a restart) — so the user doesn't have to notice the limit cleared and prompt the agent themselves. This scheduled message is flagged `isAutoContinue` (`store/db.js`) to tell it apart from one a user scheduled by hand — used in `initScheduler` (`services/scheduler.js`) to leave it *un-armed* at startup instead of firing it late if the server was down past its target reset time (the frontend's stale-auto-continue banner lets the user fire or discard it): that reset assumption is stale and unverifiable after the fact. A normal user-scheduled message still fires late on purpose (`armTimer`'s docs) — only the auto-continue kind gets this treatment.

### Context compaction and per-agent budget

Every agent is spawned with `--autocompact` set to `AUTOCOMPACT_WINDOW` (`agentProcessManager.js`'s `buildArgs`, default `200k`, `APP_AUTOCOMPACT` to override), so the CLI summarizes its own older context once a resumed session's context passes that size. Not `auto`: observed live, `auto` only compacts near the model's full window, so sessions sat at 400k–800k and every request in a turn re-read all of it — four agents nudged at once used up a freshly-reset session limit before any of them finished replying. When it fires, the CLI reports a real `{"type":"system","subtype":"compact_boundary","compact_metadata":{trigger,pre_tokens,post_tokens}}` stream-json event — confirmed directly against the installed `claude` binary, not documented in `--help` — which `createTurnAccumulator` collects as `turn.compactions` (threaded through both a resolved turn and a rejected one, same as `usage`/`totalCostUsd`) and `postCompactionNotes` in `ws/handler.js` turns into a persisted `isSystemNote` message (e.g. "🗜️ Context compacted (auto): 2,102,344 → 180,552 tokens"), otherwise invisible anywhere. `isSystemNote` messages render as a plain centered line in `app.js` (no avatar/bubble) and are excluded from `catchUpMessagesFor`/`hasSpokenInChat`/`lastOwnMessage` the same way `isLocalCommandOnly` is — nothing sent alongside one ever reached the model.

Every turn's own cost/token accounting (the CLI's `result` event `usage`/`total_cost_usd`, already used for the `'turn ended'`/`'turn errored'` log lines) is also persisted per agent: `cumulativeCostUsd` (running total across every turn, `setAgentUsage` in `store/db.js`) and `lastContextTokens` (most recent turn's input + cache-creation + cache-read tokens — roughly what it costs just to resume the session before it says anything new). Shown in the agent panel as a `💰` badge, turning red past a display-only threshold, so a session that's gotten expensive to resume is visible before it becomes a problem instead of only ever showing up in the log file after the fact.

### Persistence (`server/store/db.js`)

Single file owns the whole SQLite schema and every migration. `CREATE TABLE IF NOT EXISTS` only helps brand-new databases — any schema change needs an explicit, idempotent `migrate*()` function run unconditionally at `loadDb()` startup (see the existing `migrate*` functions for the pattern: check via `PRAGMA table_info`/`PRAGMA index_list`, no-op if already applied). A one-time legacy `data.json` → SQLite import runs automatically if a fresh DB is created and an old `data.json` is found alongside it.

### MCP server (`server/mcp/`) — Clauhort as tools

`server/mcp/index.js`'s `mountMcp(app, wss)` mounts a stateless Streamable HTTP MCP server at `/mcp`, letting an external Claude instance (Claude Code or Claude Desktop, both assumed to run on this same machine) drive Clauhort itself — create/manage chats and agents, send a message and get the reply back. Off by default: gated on `MCP_AUTH_TOKEN` being set (`mcp/auth.js`'s `isMcpEnabled`/`requireMcpToken`) — this is the app's first network-reachable, tool-calling surface, on top of an app that otherwise has zero authentication anywhere, so it gets its own token check even though it inherits the same `127.0.0.1` bind as everything else. The token is accepted either as `Authorization: Bearer <token>` or `?token=<token>`, since Claude Desktop's custom-connector setup only takes a URL with no header field.

Every tool handler (`mcp/tools.js`) calls the exact same functions the REST routes and WS handler already call (`store/db.js`, `services/agentProcessManager.js`, `services/agentRunner.js`) — there's no parallel validation/side-effect path to keep in sync. The one new capability needed to support this: `handleUserMessage` (`ws/handler.js`) used to always return `undefined` even though it already awaited every agent reply internally; it now returns `{ userMessage, replies }` so the `send_message` tool can await a real reply in-process, without a WS client of its own. Both pre-existing callers (this file's own WS dispatch, `services/scheduler.js`'s `fireScheduledMessage`) already ignored the return value, so this was purely additive. Mounted in-process deliberately — live agent-process state (`agentProcessManager.js`'s `processes` map, `activeStreams` in `ws/handler.js`) is plain in-memory state in the one Node process running `index.js`; a separate script driving `send_message` would have no visibility into a live turn to await.

Built with `@modelcontextprotocol/sdk`'s `McpServer`/`StreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`) since every tool call is an independent request/response with no server-push need — a fresh `McpServer` + transport pair is built per request (`mcp/server.js`'s `handleMcpRequest`), per the SDK's own stateless-mode contract.

### Frontend (`server/public/`)

Single `app.js` (~3500 lines, no bundler) drives the whole UI via plain DOM APIs and the WebSocket protocol defined by `server/ws/handler.js`'s JSDoc event typedefs (`USER_MESSAGE`, `AGENT_STREAM_START/CHUNK/STATUS/END/ERROR`, `AGENT_BACKGROUND_MESSAGE`, `GRANT_PERMISSION`/`DENY_PERMISSION`, `STOP_AGENT`, `MESSAGE_SAVED`, `AGENT_UPDATED`, `SCHEDULED_MESSAGE_FIRED`, `PING`/`PONG`). `markdown.js` wraps the vendored `marked.esm.js` (`server/public/vendor/`) for rendering agent replies. i18n dictionaries (`en-CA.js`, `fr-CA.js`) are plain JS objects looked up through the shared `index.js` engine — add new keys to *both* locale files. Static image assets (logo, favicon variants) live in `server/public/assets/`, served as-is at `/assets/*` alongside the rest of `server/public/`.

User-visible settings (display name, color, locale, theme) persist server-side through `server/store/db.js`'s generic settings key-value table (`getSetting`/`setSetting`) — a new one follows the existing `getUserX`/`setUserX` pair pattern, no migration needed. Theme specifically also caches to `localStorage` and is applied before first paint: a small inline script in `index.html`'s `<head>`, ahead of `style.css` and any app.js execution, reads `localStorage.getItem('theme')` and sets `data-theme` on `<html>` synchronously, so a saved light preference doesn't flash dark while the async `/api/settings` fetch in `init()` is still in flight. Any future visual (non-locale) setting that needs to avoid a flash-of-wrong-state on load should follow the same pre-paint-inline-script approach rather than waiting on `init()`.

### Versioning

`server/public/appVersion.js` (`APP_VERSION`) is the single source of truth for the app version shown in the UI (sidebar header badge, next to the app title) — same imported-unmodified-by-both-browser-and-server pattern as `appName.js`. Any change that's worth a changelog entry (new feature, notable fix, breaking change — not a drive-by refactor or test-only change) must, in the same piece of work:
- Bump `APP_VERSION` in `appVersion.js`.
- Bump `"version"` in `server/package.json` to match.
- Add an entry under `[Unreleased]` in `CHANGELOG.md` (or cut a new dated version section if the user says to release), following Keep a Changelog format.

### Logging

`server/logger.js` (pino) — every module gets its own `logger.child({ component: '<name>' })` rather than repeating fields by hand. File logging is structured JSON with daily rotation; console output stays at `info`+ regardless of `APP_LOG_LEVEL`. `server/transcriptLog.js` is separate and off by default (`APP_TRANSCRIPT_LOG`) — the only place full prompt/response content is ever written to disk, since it's a debugging-only, opt-in log distinct from the always-on structured log.
