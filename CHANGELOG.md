# Changelog

All notable changes to Clauhort are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Agents can now run as [opencode](https://opencode.ai) as well as Claude Code: the New Agent form has a "Runs as" picker. An opencode agent is a persistent `opencode acp` process spoken to over the Agent Client Protocol, and takes part in chats like any other agent (@mentions, relays, catch-up, tool calls shown in its replies, stop, resume after a restart via `session/load`). It uses its project's own `opencode.json` for model and tools, and the project's pinned `node_modules/.bin/opencode` when there is one (else `OPENCODE_BIN`, else `PATH`). opencode asks for permissions mid-turn, which Clauhort answers itself from the agent's grants (YOLO, its working directory and granted directories, granted commands), so a denied call still shows the usual permission card, and granting it resumes the session with the grant in place. A non-default provider's agents show a small badge, and the form, model picker and agent menu only offer what that provider supports. The form only offers a provider whose CLI it can find (re-checked when the working directory changes, since a project can pin its own opencode), shows which version it found and where, and tells you how to install a missing one, instead of failing on Create. Its model picker lists the models `opencode models` reports for the agent's project (`GET /api/providers/:id/models`), in the New Agent form and when switching an agent's model, with Custom still taking any model ID. See `server/services/providers/opencode.js`, `server/public/agentProviders.js` and `GET /api/providers` (`server/routes/providers.js`).
- A strip above the composer now shows every agent still replying in the open chat, as a chip with animated dots, its name, what it's doing right now ("Reading app.js", "writing…") and how long it's been going. Clicking a chip scrolls to that agent's reply and flashes it. With several agents replying at once, their live bubbles end up scattered up the scrollback between finished replies, so it was hard to tell who was still working. The agent panel also marks a replying agent (pulsing ring on its avatar, "responding…" under its name), and the chat list shows animated dots on any chat with a reply in progress, including chats you aren't looking at. See `renderTypingBar`/`syncStreamingIndicators` in `server/public/app.js`.
- An agent compacting its context now says so in its reply bubble ("🗜️ Compacting context…", then "🗜️ Context compacted, continuing…"), instead of sitting silent until the compaction finished. On a large context that can take minutes, and the turn looked stuck. Driven by the CLI's own `status` events, confirmed against CLI 2.1.301. See `createTurnAccumulator` in `server/services/providers/claude.js`.
- The bars above the message list (the topbar, search and agent-filter bars, and page navigation) can be collapsed with a ▴ button in the topbar, giving their space back to the messages. A small ▾ in the chat's corner brings them back, and shows a dot while a hidden bar has something in effect (an open search, an agent filter, an older page). Banners asking for action stay visible. The chat list and the agent panel can be collapsed the same way, with « next to the CHATS heading and » next to AGENTS: a thin strip at that edge of the window brings each back, with a dot when a chat has something unread or an agent has activity you haven't seen. On narrow windows, where they're already slide-in drawers, they stay as they were. All three are remembered per browser and applied before first paint, like the theme. See `COLLAPSIBLE_PARTS` in `server/public/app.js`.
- The context-compaction window (`--autocompact`) can now be set in two places. Settings has a default for every agent, replacing the `APP_AUTOCOMPACT` env var, which stays as the fallback. Each agent's ⋮ menu (and the New Agent form) can override it for that agent, at any point in its life. A change restarts the affected agents' processes once their current turn finishes, and their sessions resume as before. Values are checked against what the CLI accepts (`auto`, or 100k–1M), since a value it rejects stops the agent from starting. See `normalizeAutocompact` in `server/public/autocompact.js`, `buildArgs` in `server/services/providers/claude.js`, and `autocompactOverride`/`getDefaultAutocompact` in `server/store/db.js`.
- The `send_message` MCP tool takes an optional `asAgentId`, so an agent posting into its own chat shows up as itself instead of as you. Such a post goes only to the teammates it @mentions, and is never relayed back to the agent that posted it. Before this, every `send_message` was saved as the user's, and agents in a chat sometimes used it to reply, so the chat showed you saying things you never wrote. See `handleUserMessage` in `server/ws/handler.js` and `send_message` in `server/mcp/tools.js`.
- An agent waiting on a background task (e.g. a backgrounded Bash command it said it would "wait for") now shows a pulsing "⚙️ waiting on: …" badge in the agent panel until the task finishes. Before this, it looked exactly like an agent that was done. The CLI's own `background_tasks_changed` stream-json event, previously ignored, now feeds a new `AGENT_BACKGROUND_TASKS` WS event, which is also replayed to newly-connected clients. See `onBackgroundTasksChanged` in `server/services/agentProcessManager.js` and `renderBackgroundTasksBadge` in `server/public/app.js`.
- A turn the CLI resumes on its own (after a background task finishes) now streams live into a normal bubble, with status, elapsed time and a working Stop button, instead of staying invisible until it ended. Reported live: one self-resumed turn ran 50+ tool calls over many minutes with nothing on screen. Stopping it kills the agent's process, the only way to interrupt a turn nobody started. See `onBackgroundStream` in `server/services/agentProcessManager.js` and `makeBackgroundStreamFactory` in `server/ws/handler.js`.
- Adding an agent to a chat now posts a system note recording who/what did it (e.g. "➕ You added Ada to the chat" or "➕ An MCP client added Ada to the chat"), symmetric with the existing removal note below. See `postAgentAddedNote` in `server/ws/handler.js`, wired into `POST /api/chats/:id/members` (`server/routes/chats.js`) and the `add_agent_to_chat` MCP tool (`server/mcp/tools.js`).
- `@Agent /clear` now actually clears that agent's CLI session instead of being sent to the model as plain chat text — added to `ALLOWED_BUILTIN_COMMANDS` alongside `/compact`, but handled differently: confirmed live that a "/clear" genuinely rotates the CLI's `session_id` (a `system`/`conversation_reset` event, not the synthetic-assistant shape `/chrome`/`/help` produce), which would otherwise be silently discarded by the "capture resumeId once" assumption everywhere else in this app. A new `recordContextClear` (`server/store/db.js`) overwrites `resumeId` unconditionally and stamps a new `contextResetAt`, which `buildPromptBlocks`/`catchUpMessagesFor` (`server/ws/handler.js`) now check so the agent's next turn gets a full re-introduction (and full catch-up window) instead of trusting now-stale `--resume` memory. Posts a "🧹 Context cleared" system note into the chat, the same way a context-compaction does. See `contextCleared` on `createTurnAccumulator` (`server/services/agentProcessManager.js`).
- Removing an agent from a chat, or deleting an agent outright while it's a member of one, now posts a system note into that chat recording who/what did it (e.g. "🚪 You removed Ada from the chat" or "🚪 An MCP client removed Ada from the chat") — previously invisible beyond a generic `/api` request-log line, with no way to tell a REST (web UI) removal apart from one made by an external Claude instance over `/mcp`. See `postAgentRemovedNote` in `server/ws/handler.js`, wired into `DELETE /api/chats/:id/members/:agentId` and `DELETE /api/agents/:id` (`server/routes/`) and the `remove_agent_from_chat`/`delete_agent` MCP tools (`server/mcp/tools.js`).
- A new 🎤 button next to the composer transcribes speech into the message box via the browser's SpeechRecognition API, hidden entirely on a browser with no such API rather than shown disabled. See the "Dictation" section of `server/public/app.js` and `#mic-btn` in `server/public/style.css`/`index.html`.
- Each of the first nine quick messages now has an Alt+N hotkey (shown as a badge in the ⚡ panel) that inserts it into the composer, the same action as clicking it. See the quick-message hotkey `keydown` listener in `server/public/app.js`.
- A browser refresh (or first page load) while an agent was mid-turn used to show nothing at all until the turn finished — indistinguishable from the request having silently gone nowhere, especially for a turn doing background/subagent work with no text on screen yet. The server now keeps a live snapshot of every in-flight stream (accumulated text, last status, start time) and sends it to each newly-connected client as a new `AGENT_STREAM_SNAPSHOT` event, which reconstructs the exact same streaming bubble a client that stayed connected would have. See `buildActiveStreamSnapshot` in `server/ws/handler.js` and `onStreamSnapshot` in `server/public/app.js`.

### Changed
- Everything a CLI does differently now sits behind its provider: how a turn starts (including a protocol handshake), what a permission grant authorizes, where project slash commands live, and what the UI shows for it. Agents have a stored `provider`; existing agents are Claude. See `AgentProvider` in `server/services/providers/index.js` and `ProviderDisplay` in `server/public/agentProviders.js`.

### Fixed
- An agent no longer gets a turn for an @mention it has already read. A relay fires only after every turn in its round has finished, so by then the mentioned agent had often read the mention already, as catch-up in a turn started in the meantime, and it answered it a second time. Reported live: four agents woken by the same session-limit reset, in a free-relay chat, ended in a dozen rounds of "crossed in flight, nothing new" replies. Now such a relay joins the agent's running turn and shares its reply, or is dropped if that turn has already finished. See `shownTurns` in `server/ws/handler.js`.
- A reply bubble that ended in an error (such as hitting the session limit) kept its Stop button. Clicking it showed "Stopping…" forever, since the turn was already over. The button is now removed when the error arrives. See `onStreamError` in `server/public/app.js`.
- The agent panel's "⏳ resets …" badge could be cut off by an ellipsis, and its tooltip didn't say when. The tooltip now gives the full reset date, time and time zone. See `fmtFullTime` in `server/public/app.js`.
- Agents Clauhort runs could post into a chat as you, through Clauhort's own `send_message` MCP tool (visible to them whenever the MCP server is registered at user scope). Reported live: agents answered that way, and one kept doing it even after `asAgentId` existed, by leaving it out. Every agent is now started with that tool disallowed. Its normal reply already reaches the chat, and every other Clauhort MCP tool, such as reading the chat or adding and removing teammates, stays available. Set `APP_MCP_SERVER_NAME` if you registered the server under a name other than `clauhort`. See `buildArgs` in `server/services/providers/claude.js`.
- The ➕/🚪 notes recording an agent being added to or removed from a chat now include its id ("You added Ada [agent 42a8…] to the chat"). Names aren't unique, so two agents with the same name left identical notes. Notes already in a chat keep the old wording. See `agentRef` and `postAgentAddedNote`/`postAgentRemovedNote` in `server/ws/handler.js`.
- `@Agent /clear` left a blank reply instead of the "🧹 context cleared" system note, and the agent kept its old session. CLI 2.1.301 reports the reset as a top-level `conversation_reset` event, no longer a `system` subtype, so it was never detected. Both shapes are now recognized. See `createTurnAccumulator` in `server/services/providers/claude.js`.
- `@Agent /compact` left a blank reply next to its 🗜️ note. A turn that produces only a compaction now posts just the note. See `runAgentsParallel` in `server/ws/handler.js`.
- The 🗜️ compaction and 🧹 clear notes now name the agent ("Ada's context was compacted (auto): …"). A system note shows no author, so there was no telling whose context it was. Notes already in a chat keep the old wording. See `postCompactionNotes` in `server/ws/handler.js`.
- An agent could mistake who sent the message it was answering, and reply to a teammate instead of you. The message that starts a turn reached the agent without its author's name (unlike catch-up lines), so your message and a relayed teammate's reply looked the same. Reported live: right after a relay from a teammate, an agent took the user's next two questions as that teammate's and addressed both answers to them. Every message an agent sees, the triggering one and catch-up alike, is now labelled `Name [user]` or `Name [agent <id>]`, since names aren't unique, and the roster lists every agent's id, the agent's own included. Skill commands and permission-retry nudges are still sent as-is. See `authorLabel`, `formatRoster` and `buildPromptBlocks` in `server/ws/handler.js`.
- "Grant all" on a permission card could retry before every grant was applied, so the agent was denied part of a chained Bash command (e.g. `git add -A` in `git init -q && git add -A`) right after it was granted. Grants for the same agent now apply one at a time, and the retry waits for all of them. See `withPermissionLock` in `server/ws/handler.js`.
- A message sent to an agent while it was busy could hang forever, leaving its reply bubble stuck, if the agent was stopped or its process died before the message's turn came up. Since 1.2.41 this could also hang server shutdown. The waiting turn now fails with the process's exit error instead. See `runTurn` in `server/services/agentProcessManager.js`.
- A busy group chat could spiral into agents endlessly answering "same stale replay, nothing new". Every message that reached an agent mid-turn queued its own follow-up turn, and each one re-sent the same catch-up, so the agent answered the same content several times over, and those answers @mentioned teammates, who did the same. Reported live: an agent in a nine-minute turn had six more turns queued behind it. Messages that arrive while an agent is busy now fold into a single follow-up turn, built when it actually starts, which shows each message once. Catch-up now starts from what the agent last saw, so a message posted mid-turn isn't skipped. See `pendingTurns`/`runAgentsParallel` and `catchUpMessagesFor` in `server/ws/handler.js`, and `seenUntil` in `server/store/db.js`.
- Moving an agent to another chat (or stopping it, or changing its model) and messaging it straight away could fail with "Claude process exited with code 143". The old process takes about half a second to exit after being killed, and until then the new turn was sent to it. Had it answered in time, it would have answered from the old chat's session. A turn now waits for the old process to exit and runs on a fresh one. See `isAvailable`/`killAgent` in `server/services/agentProcessManager.js`.
- Turns an agent ran on its own (e.g. after a background task finished) were never counted in its 💰 cost or context size, and never got a log line, so an agent doing long background work looked far cheaper than it was. Their spend is now recorded the same way as an explicit turn's, whether the turn posted a reply, errored, or had nothing to post, and logged as `background turn ended`. See `onBackgroundUsage` in `server/services/agentProcessManager.js` and `makeBackgroundUsageHandler` in `server/ws/handler.js`.
- The 💰 badge's dollar figures were inflated. The CLI reports `total_cost_usd` as a running total for the agent's whole process, not per turn, so "last turn" showed the process total, and every turn added that whole total to the all-time figure again, including errored turns that spent nothing. Reported live: one agent showed $259 all-time. Each turn's cost is now the difference from the previous one. Totals recorded before this fix stay inflated. See `withPerTurnCost` in `server/services/agentProcessManager.js`.
- Context compaction kicked in far too late to keep costs down. Agents ran with `--autocompact auto`, which only summarizes near the model's full window, so sessions sat at 400k–800k tokens and every request in a turn re-read all of it. Reported live: four agents nudged to continue at once used up a freshly-reset session limit before any of them finished replying. Agents now compact at 200k by default, overridable with the new `APP_AUTOCOMPACT` env var. See `AUTOCOMPACT_WINDOW` in `server/services/agentProcessManager.js`.
- The 💰 badge's context size was inflated many times over, e.g. "24M ctx" for a session that was really under 1M. It summed the tokens of every request in the turn (one per tool-call step), not the session's actual size. It now uses the last request's own usage. A turn that errors before reaching the model (e.g. a session-limit rejection) also no longer resets it to 0. See `contextTokens` in `createTurnAccumulator` (`server/services/agentProcessManager.js`).
- @mentions in an agent's reply to an auto-continue "please continue" nudge were silently dropped. That reply skipped the relay step entirely, so a teammate it handed work to never heard about it. Reported live: three agents woken by the same session-limit reset each @mentioned teammates ("@Claus please commit", "@Claudian please re-verify"), and none of those mentions went anywhere, so the work stalled. These replies now relay like any other, still capped by the chat's bounded/free relay rules. See `handleUserMessage` in `server/ws/handler.js`.
- Opening Settings and changing a field (e.g. the language) quickly enough could get silently discarded: the modal was shown before its `GET /api/settings` fetch resolved, and that fetch's own field-population code ran afterward regardless, overwriting whatever the user had just picked back to the previously-saved values. The modal now only appears once every field is already populated, closing the window entirely. Caught via `tests/e2e/07-i18n.test.js` flaking on locale switches rather than by a user report. See `openSettingsModal` in `server/public/app.js`.
- Removing an agent from a chat (or changing a flag that evicts its process — a permission grant, a `workingDir`/YOLO/`resumeId` change) while its turn was still streaming truncated the reply and surfaced as an error, since `killAgent` sent SIGTERM immediately regardless of an in-flight turn. Reported live: an MCP client managing its own teammates removed one mid-turn, cutting its reply off mid-sentence. `killAgent` now waits for the agent's current turn to finish before sending the signal, unless called with `{ immediate: true }` — used only by server shutdown (`killAll`), so a long-running turn can't hang the exit. See `server/services/agentProcessManager.js`.
- `handleUserMessage`'s `@mention` relay loop reused a single chat/member-roster snapshot taken once before any turn ran, across every relay round. An agent that called the `add_agent_to_chat` MCP tool mid-turn and then `@mentioned` that same new teammate in its own reply had the mention silently dropped — the stale snapshot didn't include the new member yet, so `extractMentionedAgents` never recognized it as a valid relay target (the mentioned agent's cost stayed $0, it never even saw the message). Chat/member state is now re-read fresh at the start of every relay round. See `handleUserMessage` in `server/ws/handler.js`.
- An agent's own unprompted background retry (e.g. a self-rescheduled check-in loop hitting a still-active session limit) could get posted into the chat as a genuine reply, since only the foreground turn path special-cased an errored `result`. Background turns that end in `is_error:true` are now routed to a dedicated handler instead — never persisted as a message — which stamps the usual session-limit badge and (re-)arms auto-continue if the chat has it enabled. See `onBackgroundError`/`handleUnsolicitedEvent` in `server/services/agentProcessManager.js` and `makeBackgroundErrorHandler` in `server/ws/handler.js`.
- A turn with commentary before a tool call ("let me check X first…", then a Bash/Task/etc. call, then more text) silently lost or garbled everything after the first tool call, both live on screen and in the persisted message. Confirmed live against the real CLI: such a turn is actually a sequence of separate assistant messages (a new message id each time a tool call interrupts the model), not one message whose content keeps growing — the accumulator was comparing a new message's just-started text against the *previous* message's already-longer length, which either silently dropped it or emitted a tail fragment starting mid-string. Text is now tracked per (message id, block index), and the persisted message now uses the full accumulated text instead of just the CLI's final `result` event (which, same root cause, only ever covered the last message). See `createTurnAccumulator`/`runOneTurn` in `server/services/agentProcessManager.js`.
- Once an agent's reply had streamed any text at all, a later tool call or subagent delegation (`Task`) in the same turn had no visible effect — the "what's happening now" status row hid itself for good on the first chunk of text and never came back, so a multi-step turn looked frozen on stale text between tool calls instead of showing what the agent was doing. The status row now re-shows (and hides again once text resumes) for every status update in the turn, not just the first. See `onStreamStatus`/`showStreamStatus` in `server/public/app.js`.

### Security
- The server now binds explicitly to `127.0.0.1` instead of relying on Node's implicit all-interfaces default, which had left it unintentionally reachable from the local network (firewall permitting) despite there being no authentication anywhere in the app. Agents execute real shell/file tools against the host filesystem, so this closes an unintended exposure rather than adding a feature — LAN access was considered and deliberately rejected given that risk. See `server.listen` in `server/index.js`.

### Added
- Clauhort can now itself be driven by an external Claude instance (Claude Code or Claude Desktop) over a new MCP server at `/mcp`, exposing full chat/agent CRUD plus a `send_message` tool that posts a message and awaits the resulting agent reply/replies — every tool calls the exact same functions the REST API and UI already use. Off by default, gated on a new `MCP_AUTH_TOKEN` env var (accepted as a bearer header or a `?token=` query param, so both Claude Code's `--header` flag and Claude Desktop's URL-only custom connector work). Required `handleUserMessage` (`server/ws/handler.js`) to start returning `{ userMessage, replies }` instead of `undefined` — purely additive, both pre-existing callers already ignored the return value. See `server/mcp/`, the new "MCP server" section in README.md, and the same-named subsection in CLAUDE.md's Architecture.
- Selecting a chat now mirrors its id into the URL as `?chat=<id>`, so the address bar can be copied and pasted elsewhere (another tab, another Claude instance, a teammate) to reopen that exact chat directly — previously the chat id was deliberately kept out of the URL, restorable only via a per-tab `sessionStorage` entry. A shared link takes priority over a tab's own last-active chat on load, and Back/Forward now step through chat switches. See `CHAT_URL_PARAM`/`syncChatIdToUrl`/`getChatIdFromUrl` and the `popstate` listener in `server/public/app.js`.
- New ⚡ "Quick messages" button next to the composer lets you save short message snippets you send often (e.g. "Please continue") and insert one at the cursor with a click instead of retyping it — never auto-sent, so there's always a chance to review or tweak it first. Manage the list (add/edit/delete) right from the same dropdown. Global across every chat, persisted in a new `quick_messages` table. See `server/store/db.js`, `server/routes/quickMessages.js`, and `renderQuickMsgPanel`/`useQuickMessage` in `server/public/app.js`.
- Agents can now have their model switched — at creation via the new Model field, or on an existing agent via the ⋮ menu's "Switch model" action — as a dropdown of the `claude` CLI's own stable `--model` family aliases (Opus/Sonnet/Haiku/Fable, each always resolving to that family's latest), plus "Custom" for a full pinned model ID. A dropdown of full dated model IDs would need updating every time Anthropic ships a new one; the family aliases don't. Confirmed empirically that pairing `--model` with `--resume` genuinely switches an existing session's model without losing conversation history (the CLI reports a one-time prompt-cache rebuild on that turn, not a fresh session). Baked into spawn args like `workingDir`/`resumeId`, so changing it evicts and respawns the agent's process the same way. See `modelOverride` in `server/store/db.js`, `buildArgs` in `server/services/agentProcessManager.js`, `MODEL_ALIASES`/`setModelSelectValue`/`getModelSelectValue`, and `changeAgentModel` in `server/public/app.js`.
- Each agent's sidebar entry now shows which real model it's actually running on (e.g. "🧠 Sonnet 5"), captured from the `claude` CLI's own stream-json output on its most recent turn — this app never requests a specific model itself, so previously it was invisible which one the CLI had resolved. Persisted per agent (`last_known_model` in `server/store/db.js`, `setAgentModel`) and kept live via `AGENT_UPDATED`; see `model` on `TurnAccumulator`/`runTurn` in `server/services/agentProcessManager.js` and `formatModelLabel` in `server/public/app.js`.
- Chats can now be grouped into categories in the sidebar — hover a chat and click the 🏷️ button to open a popover listing every category already in use as a one-click option (no retyping a name that already exists), plus "Uncategorized" to clear it and "+ New category" for a name that doesn't exist yet; each category renders as a collapsible section, with Uncategorized always first. A category's ✏️/× controls rename or clear it across every chat that has it in one step, since a category is just a shared label rather than its own record. See `category` on `Chat`/`updateChat`/`renameChatCategory` in `server/store/db.js`, `PATCH /api/chats/:id` and the new `PATCH /api/chats/category` in `server/routes/chats.js`, and `renderChatList`/`openCategoryMenu`/`renameCategory`/`deleteCategory` in `server/public/app.js`.
- Every rendered code block in an agent's reply now gets a copy button (revealed on hover, top-right of the block) — no more manually selecting code to copy it. See `decorateCodeBlocks`/`copyCodeBlock` in `server/public/app.js` and the `.md-code-wrap` container `markdown.js`'s `renderer.code` now wraps each block in.
- Chats can now be renamed from the sidebar — hover a chat item and click the ✏️ button to edit its name in place (Enter to save, Escape to discard). See `PATCH /api/chats/:id` in `server/routes/chats.js` (now rejects a blank name) and `startRenameChat` in `server/public/app.js`.
- Every agent is now spawned with `--autocompact auto`, so the CLI summarizes its own older context once a resumed session's cache grows large instead of every turn paying to re-read a multi-million-token history in full. When it fires, a new "🗜️ Context compacted" note is posted into the chat — confirmed directly against the installed CLI binary that this is a real, previously-unsurfaced `compact_boundary` stream event, not something this app had any visibility into before. See `buildArgs`/`createTurnAccumulator` in `server/services/agentProcessManager.js`, `postCompactionNotes` in `server/ws/handler.js`, and the new `isSystemNote` message kind (rendered as a plain centered line, not a bubble) in `server/store/db.js`/`server/public/app.js`.
- The agent panel now shows a running 💰 cost total and the most recent turn's resumed-context size (e.g. "$12.45 · 9.7M ctx"), turning red past 2M tokens as a nudge to consider starting a fresh session — previously this only ever showed up in the log file after the fact. See `cumulativeCostUsd`/`lastContextTokens`/`setAgentUsage` in `server/store/db.js` and `formatUsageLabel` in `server/public/app.js`.

### Fixed
- `@Agent /compact` was silently sent to the model as plain chat text instead of triggering the CLI's real compaction — `parseSkillInvocation` only forwarded a bare command when it matched a registered project command or a skill the agent's live process reported, and `/compact` (a genuine CLI built-in) is in neither list. Carved out specifically for `/compact` rather than built-ins generally, since it's only ever invoked against a session already well past the point its one-time identity preamble would have gone out. See `ALLOWED_BUILTIN_COMMANDS`, now in `server/services/commands.js`.
- `/compact` never showed up in the composer's "/" autocomplete, even though it was already forwardable (see the entry above) — the dropdown's list came from `mergeSkills`, which only ever draws builtins from the CLI's own `skills` init field, and `/compact` (a true built-in) lives in the separate `slash_commands` field this app never read. `mergeSkills` now always includes `ALLOWED_BUILTIN_COMMANDS` regardless of what the live process reported. See `server/services/commands.js`.
- The "🗜️ Context compacted" note (added for `--autocompact auto` below) only ever posted for a compaction that happened during an explicit turn — one the CLI triggered while an agent's process was otherwise idle (a background task resuming on its own, say) arrived as a `system/compact_boundary` event with no turn in flight to attach it to, and `handleUnsolicitedEvent`'s type filter silently dropped it, with nothing else ever surfacing that it happened. New `onBackgroundCompaction` mirrors the existing `onBackgroundTurn` background-task mechanism to post the note for this case too. See `server/services/agentProcessManager.js` and `makeBackgroundCompactionHandler` in `server/ws/handler.js`.
- The agent panel's 💰 cost/budget badge clipped its label (`white-space: nowrap` + ellipsis) inside the fixed 240px agent panel, with no way to recover the truncated text — hovering only explained what the fields meant, never repeated the actual numbers. `.agent-usage` now wraps instead of truncating, and its tooltip includes the exact (unrounded) cost and token figures. See `server/public/style.css` and `formatUsageExact` in `server/public/app.js`.
- The wrap-instead-of-truncate fix above traded clipped text for a worse problem: the badge's one long string ("$12.45 all-time (+$0.03 last turn) · 9.7M ctx") wrapped at arbitrary character boundaries inside the narrow panel, breaking mid-word/mid-number across up to three ragged lines. `formatUsageLabel` now returns two pre-split parts (`primary`: the all-time cost, `secondary`: the last-turn delta + context size) rendered as their own lines, each independently truncated with ellipsis rather than wrapping — a clean, predictable two-line badge instead of a reflowed run-on sentence. See `formatUsageLabel`/`renderUsageBadge` in `server/public/app.js` and `.agent-usage` in `server/public/style.css`.
- Long quick messages were clipped to a single ellipsized line in the ⚡ panel, making entries that happened to share the same opening words visually indistinguishable from each other. `.quick-msg-item-text` now clamps to 3 lines instead of truncating to 1; see `server/public/style.css`.
- The ⚡ Quick messages panel could render partly clipped behind the agent side panel, since it opened `left: 0` from a trigger button positioned near the right edge of the composer, pushing part of its width past `#chat-area`'s `overflow: hidden` boundary. Now opens `right: 0` (anchored to, and growing leftward from, the trigger button) with a `max-width` safety guard; see `#quick-msg-panel` in `server/public/style.css`.
- A session-limit auto-continue message in a multi-agent `freeRelay` chat could cascade through the whole team's mutual @mentions — each an expensive resumed turn — re-exhausting a freshly-reset session limit within minutes of it resetting, having done almost no real work. Auto-continue messages now skip the relay step entirely (`isAutoContinue`/`skipRelay` in `server/store/db.js`/`server/ws/handler.js`), staying a private nudge to just the one agent that hit the limit.
- An overdue auto-continue message (the server was down past its target reset time) would fire immediately on the next startup against a now-stale assumption, risking the same cascade above. `initScheduler` (`server/services/scheduler.js`) used to just drop it instead — safe, but it took the decision away from the user entirely. It now leaves the row un-armed and pending instead of deleting it: opening that chat shows a banner with the stuck message and lets the user fire it now or discard it. See the new `fire-now` route in `server/routes/chats.js` and `renderStaleAutoContinueBanner`/`fireScheduledNow` in `server/public/app.js`.
- A chat/agent change made via an MCP tool call (`create_agent`, `update_agent`, `delete_agent`, `create_chat`, `update_chat`, `delete_chat`, `add_agent_to_chat`, `remove_agent_from_chat`) never reached any already-open browser tab — unlike the UI's own REST calls, an MCP caller is never a browser tab that could just patch its own local state after the fetch, so the change sat invisible until a manual refresh. Every one of those tools now also `broadcast()`s the matching `AGENT_CREATED`/`AGENT_UPDATED`/`AGENT_DELETED`/`CHAT_CREATED`/`CHAT_UPDATED`/`CHAT_DELETED` event, handled client-side the same way `AGENT_UPDATED` already was. See `server/mcp/tools.js` and the new `onAgentCreated`/`onAgentDeleted`/`onChatCreated`/`onChatUpdated`/`onChatDeleted` handlers in `server/public/app.js`.

## [1.2.14] - 2026-09-10

### Added
- Deleting a chat now offers an "also permanently delete its N agents" checkbox in the confirmation dialog — a convenience for tearing down a whole chat's worth of agents at once instead of deleting each one individually afterward. Safe by construction: an agent belongs to at most one chat at a time, so a chat's members can never belong to some *other* chat this would affect. Off by default, matching the previous behavior. See the `DELETE /api/chats/:id?deleteAgents=true` route in `server/routes/chats.js`.

## [1.2.13] - 2026-09-06

### Added
- Forum-thread-style pagination for the message view — a chat's history is now split into fixed-size pages (50 messages), with « First / ‹ Prev / Next › / Last » controls. Opening a chat (or a browser refresh) lands on the latest page, same as before; older pages are reachable via the nav bar instead of being invisible once a chat passes 50 messages. Live messages/streaming only render while viewing the latest page — an older page is a frozen snapshot, matching a forum thread rather than an auto-scrolling feed. See `getMessagesPage`/`getMessageCount` in `server/store/db.js` and `loadMessagesPage` in `server/public/app.js`.

### Fixed
- Nothing was actually being deleted, but a chat past 50 messages previously had no way to reach anything older than the default recent-message window after a reload — the pagination above is the fix.

## [1.2.12] - 2026-09-04

### Added
- A per-chat "Auto-continue" toggle (⏳ in the chat topbar, `PATCH /api/chats/:id`) — when on, an agent turn that errors out on Claude's own session-limit message (e.g. "You've hit your session limit · resets 7:20pm (Australia/Darwin)") auto-arms a scheduled `@Agent` "please continue" message for one minute after that reset time, using the same scheduled-message mechanism as the 🕐 panel (visible there, cancelable, survives a restart). Off by default. See `server/services/sessionLimitReset.js` for the timezone-aware reset-time parsing and `maybeScheduleAutoContinue` in `server/ws/handler.js`.

## [1.2.11] - 2026-09-03

### Added
- Each agent message now has an "@" button next to the author's name that inserts `@Name ` into the composer — a quicker way to address a specific agent in a multi-agent chat than typing "@" and picking them off the autocomplete dropdown every time.

## [1.2.10] - 2026-09-03

### Added
- The agent panel now flags an agent with a small blue dot when they've sent a message while the message filter (🔎 spotlight) was focused on someone else — easy to miss a reply otherwise, since a non-spotlighted agent's messages stay hidden in place. Clears the moment that agent gets spotlighted or the filter is cleared.

## [1.2.9] - 2026-09-03

### Added
- The sidebar logo is now clickable — opens the full-size logo in the same lightbox overlay used for message image attachments, instead of only ever showing as a 20px header icon.

## [1.2.8] - 2026-08-31

### Added
- A per-chat "Free agent relay" toggle (🔁 in the chat topbar, `PATCH /api/chats/:id`) — when on, the agent-to-agent delegation relay is no longer capped at one hop: the same agent can be relayed again in a later round for as long as new `@mentions` keep appearing, bounded only by a safety ceiling (`FREE_RELAY_MAX_ROUNDS` in `server/ws/handler.js`, 20 rounds) against a runaway two-agent back-and-forth. Off by default, matching the previous single-hop-only behavior.

## [1.2.7] - 2026-08-31

### Fixed
- The agent-to-agent delegation relay (an agent's reply `@mentioning` a teammate, triggering that teammate once) handed the relayed agent the *original user message* as its turn-trigger content instead of the teammate reply that actually contained the mention — so the relay target would see a final message addressed to someone else, conclude it wasn't for them, and hold instead of engaging with what it was relayed in for. `runAgentsParallel`'s relay call (`server/ws/handler.js`) now groups relay targets by the specific message that mentioned them and uses that message's own content as the trigger.

## [1.2.6] - 2026-08-22

### Added
- The schedule-message modal now has its own content field, pre-filled from whatever's in the composer (or from the message being edited) but editable in place — fixes clicking the 🕐 button before typing anything, which used to open a modal with no way to see or fix the "content required" error it produced on submit.
- Pending scheduled messages can now be edited (✎ button in the scheduled panel) — change the content, attachments, or send time of a message that hasn't fired yet, instead of only being able to cancel and re-create it. Backed by a new `PATCH /api/chats/:id/scheduled-messages/:scheduledId` endpoint.

### Fixed
- Rescheduling a pending message to a new time re-armed its in-memory timer without clearing the previous one first — the old timer would still fire at the original time with the pre-edit content. `armTimer` (`server/services/scheduler.js`) now clears any existing timer for that id before arming the new one.

## [1.2.5] - 2026-08-21

### Added
- A "Grant all" button on a permission-denial card with more than one pending row — grants every still-unresolved row in that card at once instead of clicking "Grant" per row, while individual grant/deny buttons remain available for resolving rows one at a time or mixing grants and denials within the same card.

## [1.2.4] - 2026-08-21

### Fixed
- Switching away from a chat before or while an agent's reply was still streaming, then switching back, showed no sign the reply was in progress — and once it finished, the reply never rendered at all, only resurfacing after another chat switch forced a fresh reload. `streamingEntries` (`server/public/app.js`) only tracked a stream's state while its chat happened to be the active one, and `selectChat` never reconciled with streams still running elsewhere. Streaming state (accumulated text, live status, elapsed timer) is now tracked per-stream regardless of which chat is on screen, and `selectChat` detaches/reattaches the DOM bubble as you switch chats so an in-progress reply picks back up exactly where it left off.

## [1.2.3] - 2026-08-20

### Fixed
- Browser access (`chromeAccess`) was enforced as a single, app-wide singleton — creating or editing a second agent with it enabled returned a 409 conflict. That guard assumed the Claude in Chrome extension only holds one paired connection at a time, but the extension actually bridges through a local WebSocket relay (`ws://localhost:8765`) that scopes each connecting `--chrome` CLI process to its own isolated MCP tab group, so concurrent agents don't steal each other's pairing. Removed the singleton check (`getChromeAccessAgent` in `server/store/db.js`, and both call sites in `server/routes/agents.js`) and the "only one agent app-wide" copy in the UI hint/error strings — any number of agents may now hold browser access at once.

## [1.2.2] - 2026-08-20

### Fixed
- An agent whose turn failed at the CLI level (most commonly an invalid `resumeId` — a stale or hand-typed session ID rejected by `--resume`) rendered a completely empty reply bubble with no error text and no indication anything went wrong, and silently failed the exact same way on every later message. The CLI actually reports this as a well-formed `result` event with `is_error: true` and the real message in `errors`, not a crash — `createTurnAccumulator` (`server/services/agentProcessManager.js`) was treating any `result` event as a successful (if possibly empty) completion. It now recognizes `is_error` and rejects the turn instead, surfacing the CLI's actual error message to the user via the existing `AGENT_STREAM_ERROR` path.
- Two more spots carried the same hyphen-breaking `\w+` mention pattern fixed in 1.2.1, found while fixing it: the client-side spotlight/message-filter mention scan (`extractMentionedAgentIds` in `server/public/app.js`) could show a message under the wrong spotlight filter for a hyphenated-name agent, and the composer's `@`/`/` autocomplete (`updateComposerDropdown`) silently closed the dropdown the moment you typed a hyphen into a mention or an addressed agent's name. Both now match against real agent names / any non-whitespace run instead of `\w`.

## [1.2.1] - 2026-08-19

### Fixed
- `@mention` routing silently broke for any agent name containing a hyphen (or any other non-word character): `@TP-Observer` matched only `@TP`, resolved to no agent, and the message quietly fell back to broadcasting to the whole chat instead of erroring or routing correctly. Found via the new manual test plans in `test-plans/`. `extractMentionedAgents` and `parseSkillInvocation` (`server/services/messageRouter.js`) now match mentions against the chat's actual member names instead of a fixed `\w+` character class, so any character the agent-creation form already allows in a name is mentionable.

## [1.2.0] - 2026-08-18

### Added
- Message search within a chat: a 🔍 button in the chat topbar opens a search bar that queries the chat's full message history (not just the recently loaded window), showing highlighted-match results you can click to jump straight to that message — loading the surrounding context and scrolling/flashing it into view if it isn't already loaded, with a "Back to latest" banner to return to the normal view.

## [1.1.7] - 2026-08-17

### Fixed
- Clicking a sent image attachment opened a new browser tab that stayed permanently blank — Chrome silently blocks top-level navigation of a new tab straight to the `data:` URI attachment images are stored as. Now opens in an in-page lightbox instead.

## [1.1.6] - 2026-08-17

### Added
- A "Restart agent" action in each agent's `⋮` menu, plus its backing `POST /api/agents/:id/restart` route — kills and respawns the agent's persistent CLI process (no chat history lost) so it can pick up state that's only ever read once at spawn time and never refreshed, like a newly-authorized MCP connector, without restarting the whole server.

## [1.1.5] - 2026-08-16

### Fixed
- A built-in Claude Code skill (e.g. `/code-review`) sent right after an agent's process respawned (server restart, or any permission grant/workingDir/YOLO/resumeId change) was no longer recognized as a real skill invocation and silently fell back to plain-chat routing. Found during manual QA of the 1.1.4 feature.

## [1.1.4] - 2026-08-16

### Added
- The composer's `/` autocomplete now also offers an agent's built-in Claude Code skills (e.g. `/code-review`), not just its project-level `.claude/commands/*.md` files — read straight from the agent's own live process, which reports its actual invokable skill set on spawn.

## [1.1.3] - 2026-08-16

### Changed
- The `@mention` autocomplete dropdown now shows an agent's note (if it has one) below its working directory, making it easier to pick the right agent by what it's currently doing.

## [1.1.2] - 2026-08-16

### Changed
- Per-agent panel actions (note, open folder, remove, delete) now live behind a single `⋮` overflow menu instead of five always-reserved icon slots crammed next to the agent's name/directory/note. The filter button stays inline as the one frequently-used action.

## [1.1.1] - 2026-08-15

### Changed
- Editing an agent's note now opens a proper modal instead of an inline textarea cramped into the 240px-wide agent panel.

### Fixed
- The create-agent modal no longer overflows the viewport on smaller screens — its field list now scrolls internally while the header and Cancel/Create buttons stay pinned in view.

## [1.1.0] - 2026-08-15

### Added
- Per-agent note: an optional, freeform reminder of why an agent was created / what it's for, set at creation or added/edited any time from the agent panel (🗒). Purely for the user's own reference — never sent to the CLI or the agent.

## [1.0.2] - 2026-08-15

### Added
- App logo and favicon (browser tab icon, in the sizes/formats browsers expect), generated from a new logo image. The logo also appears next to the app name in the sidebar header.

## [1.0.1] - 2026-08-15

### Added
- Version number displayed in the sidebar header, linking to this changelog.

### Fixed
- Browser-access badge (🌐) now shows in the `@mention` autocomplete dropdown, matching the badge already shown in message headers and the agent panel.

## [1.0.0] - 2026-08-15

Initial release.

### Added
- Multi-agent group chat: each agent is a real, persistent `claude` CLI process running against its own working directory, kept alive across turns so MCP servers and other session state survive between messages.
- `@mention` routing between the user and agents, and agent-to-agent relay (an agent's reply can `@mention` a teammate to bring them into the conversation, depth-capped to prevent loops).
- Observer agents that only respond when explicitly `@mentioned`, catching up on the full chat history rather than the normal recent-message window.
- Scheduled messages, sent automatically at a future time.
- Slash-command invocation of an agent's real Claude Code skills (`@Name /command`).
- Permission flow for tool calls: file-path grants (`Write`/`Edit`/`Read`/`NotebookEdit`) widen the agent's allowed directories, other tool grants (e.g. `Bash`) derive scoped `--allowedTools` patterns; an optional per-agent YOLO mode skips permission checks entirely.
- Optional per-agent browser access via the Claude in Chrome extension (one agent app-wide at a time).
- Chat and agent management: create/delete chats, create/delete agents, add/remove agents from chats.
- Markdown rendering of agent replies, file attachments, and directory browsing for picking an agent's working directory.
- User settings: display name, message color, light/dark theme, and language (English/French, Canada), persisted server-side.
- Structured logging (pino) with daily file rotation, and an opt-in full transcript log for debugging.
- SQLite persistence with a one-time import from a legacy `data.json`, if present.

[Unreleased]: https://github.com/Bwca/app_clauhort/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/Bwca/app_clauhort/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Bwca/app_clauhort/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/Bwca/app_clauhort/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Bwca/app_clauhort/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Bwca/app_clauhort/releases/tag/v1.0.0
