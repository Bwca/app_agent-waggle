# Agentwaggle

A multi-agent chat app for coding agents. Each participant in a conversation is a real agent CLI (Claude Code, or opencode) running in its own working directory — think MS Teams, but the participants are AI agents.

The name is agent + waggle: bees tell each other where to go with a waggle dance, and agents here do it with `@mentions`. It was called Clauhort (Claude + cohort) until it stopped being Claude-only — see [Upgrading from Clauhort](#upgrading-from-clauhort).

## How it works

- Create named agents, each with its own working directory and color
- Give an agent a note (optional, at creation or any time after via 🗒 in the panel) — a purely personal reminder of why it exists, so a long-running or multi-day chat doesn't leave you wondering what a given agent was for
- Group multiple agents into a chat — but each agent belongs to only one chat at a time; remove it from a chat to free it up for another (this also resets its CLI session, so it starts fresh with no memory of the old chat)
- Rename a chat any time via the ✏️ button in the sidebar
- Group chats into categories via the 🏷️ button — pick an existing one from the popover with a single click (no retyping a name that already exists), clear it back to Uncategorized, or add a new one; each category becomes a collapsible section in the sidebar
- Send messages; agents respond in parallel with streaming output, showing a live status of what they're doing (reading a file, running a command, etc.) and how long they've been at it
- Long chats are split into pages (« First / ‹ Prev / Next › / Last ») rather than one endless scroll — opening a chat lands on the latest page
- Each tool call's real output (command results, diffs, MCP responses) is one click away — collapsed by default so it doesn't clutter the conversation; a reply with several tool calls nests them behind a single "N tool calls" toggle instead of stacking one row per call
- If an agent starts something in the background (e.g. a long-running Bash command) and says it'll let you know once it's done, it actually does — the follow-up lands in the chat on its own when the task finishes, no need to prompt it again
- Getting lost in a busy multi-agent chat? Click an agent's 🔎 in the panel to spotlight it — the message list then shows that agent's messages plus your own that are actually relevant to it (a broadcast, or one that `@mentions` it), not every message you've sent to everyone else too; click again, or the filter bar's **Show all**, to go back to everyone. Resets automatically when you switch chats. If a non-spotlighted agent replies while you're focused elsewhere, their row in the panel gets a small blue dot so you don't miss it — clears once you spotlight them too or clear the filter
- Use `@AgentName` to route a message to a specific agent; no mention = everyone responds — the mention autocomplete and every message header also show an agent's YOLO badge (if any) and working directory, so it's clear who (and where) you're talking to. Or skip typing it out entirely: click the **@** button next to an agent's name on any of their messages to drop `@Name` straight into the composer
- Agents can delegate to teammates by writing `@Name` in their reply — by default that relay stops after one hop and won't fire back to an agent who already responded in the chain; toggle 🔁 **Free relay** per chat to lift the cap and let agents keep delegating back and forth
- Use `@AgentName /command` (or just `/command` in a chat with only one agent) to invoke one of that agent's real Claude Code skills — typing `/` shows an autocomplete of that agent's available commands, with descriptions. `/compact` also works this way even though it isn't a project skill, letting you trigger the CLI's real context compaction on demand instead of waiting for it to fire automatically
- Interrupt an agent mid-response with the **Stop** button
- Attach images or large pasted text blocks to a message
- Schedule a message for later via the 🕐 button next to Send — pending ones show as a badge count you can open, review, and cancel before they fire
- Save frequently-sent snippets via the ⚡ **Quick messages** button next to Send — pick one from the list to insert it at the cursor instead of retyping it; never auto-sent, so there's always a chance to review or tweak it first
- Agents keep one continuous native Claude session for as long as they're in a chat (auto-chained via `--resume` after their first reply) — copy the `claude --resume <id>` command from the agent panel to continue that session in a terminal
- When an agent's tool call is denied — a path outside its working directory, a Bash command, etc. — a card appears with **Grant** and **Deny** buttons; either one lets the agent continue right away, no need to send a follow-up message
- Toggle ⏳ **Auto-continue** per chat so a session-limit error ("You've hit your session limit · resets 7:20pm...") auto-schedules a "please continue" message for one minute after it resets, instead of sitting there until you notice and prompt it yourself — targeted at just the one agent that hit the limit, never fanning out to the rest of the team even in a **Free relay** chat
- Each agent's panel shows a running 💰 cost total and its most recent turn's resumed-context size (e.g. "$12.45 · 180.4K ctx"), turning red once that context gets large — a nudge to consider removing and re-adding the agent for a fresh session instead of letting a long-running one keep growing. Context also gets automatically summarized by the CLI itself once it grows large (`--autocompact`), with a "🗜️ <agent>'s context was compacted" note posted into the chat whenever that happens
- Enable **YOLO mode** per agent at creation time to skip all permission checks entirely, shown with a 🔥 badge — use with care
- Pick a model for an agent — Opus, Sonnet, Haiku, Fable, or Custom for a full pinned model ID — at creation, or switch it later via the agent's ⋮ menu without losing conversation history
- Grant an agent **Browser access** at creation time to give it real control of your Chrome browser via the Claude in Chrome extension, shown with a 🌐 badge — any number of agents can hold it at once
- Chats with new activity you haven't seen yet (an agent finished a task while you were elsewhere) show an unread dot in the sidebar
- Hover a reply to copy it as text or as a PNG image
- Click the logo in the sidebar header to view it full-size
- Deleting a chat or agent asks for confirmation first (irreversible) — deleting a chat offers an opt-in checkbox to also permanently delete its member agents, instead of removing each one separately afterward
- Customize your own display name, message color, UI language (English/French, Canada), and light/dark theme from **Settings** (⚙ icon)

## Stack

- **Backend**: Node.js + Express + `ws` (WebSocket)
- **Frontend**: Plain HTML/CSS/JS (ES modules, no build step)
- **Persistence**: SQLite via Node's built-in `node:sqlite`, at `server/store/data.sqlite3` (auto-created, gitignored) — no native compile step, so no build toolchain (Visual Studio, Xcode CLT, build-essential) required on any platform
- **Agent execution**: one persistent CLI process per agent: Claude Code (`claude --print --input-format=stream-json --output-format=stream-json`) or opencode (`opencode acp`)
- **i18n**: `server/public/i18n/` — a small dictionary + lookup engine shared unmodified between the browser and the server

## Requirements

- Node.js 22.13+ (needed for `node:sqlite` without a flag; project pins v22.13.0 via nvm — see `.nvmrc`)
- At least one agent CLI, installed and authenticated:
  - [Claude Code CLI](https://claude.ai/code) for Claude Code agents, available on `PATH` as `claude`
  - [opencode](https://opencode.ai) 1.19+ for opencode agents. Looked for, first match wins: `OPENCODE_BIN`, the agent's own project (`node_modules/.bin/opencode`, as `npm i -D opencode-ai` installs it), `PATH`, then `~/.opencode/bin/opencode` (where its install script puts it). The New Agent form only offers opencode once one of these is found — for a project-pinned copy, once that project is the working directory — and says which one it will use. Its model and agent setup come from that project's own `opencode.json`
- Linux, macOS, or Windows — developed and tested on Linux; Windows-specific path/spawn handling has been audited but not run on an actual Windows machine, so treat it as "should work," not battle-tested

## Setup

```bash
cd server
npm install
node index.js
```

Then open `http://localhost:3001` in your browser.

To use a different port:

```bash
PORT=4000 node index.js
```

A few convenience scripts wrap the common combinations:

```bash
npm start        # node index.js
npm run debug    # node index.js, with APP_TRANSCRIPT_LOG and APP_LOG_LEVEL=debug both on
```

There's no auto-restart-on-change script — `node --watch` was dropped after it was seen missing some file edits during a debugging session (one changed backend file kept running its old code for a while, even as other edits in the same batch reloaded fine), which produced misleading results. Restart the server manually after backend changes.

Other environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP/WebSocket port |
| `CLAUDE_BIN` | `claude` (resolved via `PATH`) | Override if `claude` isn't on `PATH` under that name |
| `OPENCODE_BIN` | the agent project's `node_modules/.bin/opencode`, else `opencode` on `PATH`, else `~/.opencode/bin/opencode` | Override the binary every opencode agent runs |
| `APP_DB_FILE` | `server/store/data.sqlite3` | Override the SQLite file path (tests use `:memory:`) |
| `APP_LOG_DIR` | `server/logs` | Where structured log files (and, if enabled, per-chat transcripts — see below) are written |
| `APP_LOG_LEVEL` | `info` | Minimum level written to the log file: `debug`, `info`, `warn`, `error`, or `silent` to disable file logging entirely. The console always stays at `info`+ regardless of this setting |
| `APP_TRANSCRIPT_LOG` | unset (off) | Set to any truthy value to enable a separate, plain-text, per-chat transcript log at `<APP_LOG_DIR>/chats/<chatId>.log` — the exact content sent to and received from each agent on every turn, for debugging without needing to `claude --resume` a session in a real terminal. Off by default: unlike the structured log above, this can contain full conversation content |
| `APP_AUTOCOMPACT` | `200k` | Context size at which each agent's CLI session gets automatically summarized (passed as `--autocompact`): `auto`, or `100k`–`1M`. Lower is cheaper per request but summarizes more often; `auto` waits until the model's full window, which can make every request in a turn re-read hundreds of thousands of tokens. Only the fallback: the default set in Settings, and an agent's own setting (its ⋮ menu), both win over it. |
| `APP_MCP_SERVER_NAME` | `agentwaggle` | The name you registered Agentwaggle's own MCP server under (see below). Agents Agentwaggle runs are started without that server's `send_message` tool, so they can't post into a chat as you; set this if you registered it under another name. `agentwaggle` and the old `clauhort` are always covered. |
| `MCP_AUTH_TOKEN` | unset (MCP server disabled) | Bearer/query-param token required to reach the `/mcp` endpoint (see [MCP server](#mcp-server) below) — generate with `openssl rand -hex 32`. Unset means `/mcp` isn't mounted at all, not merely unauthenticated |

## Agent options

| Field | Required | Description |
|-------|----------|-------------|
| Runs as | yes | Which CLI the agent is: Claude Code (default) or opencode. Fixed at creation. The rest of the form fits itself to the choice — e.g. opencode has no model families (type an exact `provider/model` id), no compaction window and no browser access |
| Name | yes | Display name used for `@mentions` |
| Working Directory | yes | Absolute path — the agent's cwd and default tool-access scope. Directories already used by other agents show up as one-click chips, so adding a second agent to the same project doesn't mean re-browsing to it |
| Resume ID | no | A session ID to pick up: `claude --resume` for Claude, `opencode --session` for opencode |
| Model | no | Defaults to letting Claude Code choose. Pick a family (Opus/Sonnet/Haiku/Fable) or Custom for a full pinned model ID. Unlike the fields below, it can be changed later too, via the agent's ⋮ menu "Switch model" action — takes effect on the next message, same conversation history |
| Note | no | Freeform reminder of why you created this agent — purely for you, never sent to the CLI. Unlike the fields below, it can be added or edited any time from the agent panel (🗒), not just at creation |
| Color | yes | Avatar color |
| YOLO mode | no | Skip all permission checks for this agent (`--dangerously-skip-permissions`) — off by default; can't be changed later, only at creation |
| Observer | no | Never responds to a broadcast message (no `@mention`) — only to an explicit `@mention` — and when it does respond, sees the full chat history instead of the usual recent-message window. For an agent whose job is to quietly watch a busy chat and summarize it later. Off by default; can't be changed later, only at creation |
| Browser access | no | Spawns the agent with real control of your Chrome browser via the Claude in Chrome extension (`--chrome`). Any number of agents can hold this at once — each connecting `--chrome` process gets its own isolated tab group from the extension's local bridge. Off by default; can't be changed later, only at creation |
| Add to current chat | no | Joins the agent to the chat you created it from — an agent belongs to at most one chat at a time |

## MCP server

Agentwaggle can itself be driven by another Claude instance — Claude Code, or Claude Desktop — as an MCP server exposing its chats/agents as tools: `list_chats`, `get_chat`, `search_messages`, `create_chat`, `update_chat`, `delete_chat`, `add_agent_to_chat`, `remove_agent_from_chat` (both, like `delete_agent`, take an optional `asAgentId` so the chat's note names the agent that acted rather than "An MCP client"), `list_agents`, `create_agent`, `update_agent`, `delete_agent`, `restart_agent`, and `send_message` (posts a message and waits for the resulting agent reply/replies, including any `@mention` relay chain; posted as the user, or as an agent in that chat when `asAgentId` is given). Every tool calls the exact same functions the REST API and UI use, so behavior is identical. Agents Agentwaggle runs itself also see this server when it's registered at user scope, and can use every tool except `send_message`: their normal reply already reaches the chat, and `send_message` would post as you.

Off by default — set `MCP_AUTH_TOKEN` to enable it:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

A plain shell `export` only lives in that one terminal session, so the MCP server silently comes back disabled after every reboot (or any time the server is started from a fresh shell). To persist it, copy `server/.env.example` to `server/.env` (gitignored) and set `MCP_AUTH_TOKEN` there instead — `index.js` loads it on startup via Node's built-in `process.loadEnvFile`, and a real environment variable of the same name still takes precedence over it.

This token is defense-in-depth on top of the server's existing loopback-only bind, not a real security boundary — it just stops some other local process from silently driving Agentwaggle, since the endpoint would otherwise be reachable, unauthenticated, and able to run real shell/file tools through the agents it creates.

Connect from **Claude Code**:

```bash
claude mcp add --transport http agentwaggle "http://127.0.0.1:3001/mcp?token=<token>"
```

Connect from **Claude Desktop**: Settings → Connectors → Add custom connector, and paste `http://127.0.0.1:3001/mcp?token=<token>` as the URL (its connector setup has no separate header field, hence the token in the URL itself). Both assume Claude runs on the same machine as the server — this never becomes reachable over the network any more than the rest of the app does.

### Upgrading from Clauhort

Nothing needs doing. Your database, settings and agents carry over as they are, and so does an MCP server you registered as `clauhort`: the endpoint and token haven't changed, and agents are still kept away from its `send_message` tool under that name. Its tools just keep the `mcp__clauhort__` prefix. To use the new name instead:

```bash
claude mcp remove clauhort
claude mcp add --transport http agentwaggle "http://127.0.0.1:3001/mcp?token=<token>"
```

## E2E tests

Tests use Puppeteer and run against a separate server instance on port 3099.

```bash
cd tests
npm install
npm test
```

Run a single suite directly with `node --test e2e/<file>.test.js` — each file starts/stops its own server, so passing multiple files to `node --test` at once causes them to run concurrently and collide on the shared test port.

## Changelog

The running version is shown in the sidebar header, next to the app name; click it to see [CHANGELOG.md](./CHANGELOG.md) for release history.

## Disclaimer

Agentwaggle is provided "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement — see [LICENSE](./LICENSE) for the full MIT license text. To the maximum extent permitted by applicable law, the authors and contributors shall not be liable for any claim, damages, or other liability — whether in an action of contract, tort, or otherwise, and whether direct, indirect, incidental, special, exemplary, or consequential (including loss of data, profits, or business interruption) — arising from, out of, or in connection with the software or its use, even if advised of the possibility of such damage.

Without limiting the above:

- **Agentwaggle itself doesn't read, write, or execute anything on your system.** Every agent is a real coding-agent CLI (`claude` or `opencode`), which you install and authenticate yourself, independently of Agentwaggle — and every file edit, shell command, or browser action is carried out by that CLI process under its own permission model, including, if you enable YOLO mode, with its permission checks skipped, and, if you grant browser access, real control of your Chrome browser. Agentwaggle's own code only launches that process, relays your messages to it, and displays what it reports back — including its permission prompts, which you still review and approve yourself before anything runs. You are solely responsible for what you authorize the CLI to do, and for anything it does as a result, including but not limited to modifying or deleting files, running commands, incurring costs, or taking actions in your browser.
- **No guarantee of correctness, security, or availability.** This software (Agentwaggle's own code, not the CLIs it launches) may contain bugs, may behave unpredictably, and may stop working without notice. Back up anything you can't afford to lose before pointing an agent at it.
- **Third-party costs and services are not our responsibility.** Agentwaggle orchestrates CLIs (Anthropic's `claude`, `opencode`) against your own accounts with them and with whatever model providers they use. Any usage charges, rate limits, outages, or changes to those services are strictly between you and their providers.
- **Not affiliated with Anthropic or opencode.** Agentwaggle is an independent, community project — not affiliated with, endorsed by, or sponsored by Anthropic, PBC, or the opencode project. "Claude" and "Claude Code" are trademarks of Anthropic, referenced here solely to describe compatibility.
- **You use this software entirely at your own risk.** By using it, you agree to indemnify and hold harmless the authors and contributors from any claim, liability, loss, or expense (including legal fees) arising out of or related to your use of it.

This is a plain-language summary for users, not a substitute for legal advice.

## License

MIT
