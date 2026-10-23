/**
 * @fileoverview Agentwaggle — plain JS frontend.
 * No build step. Talks to the server via REST + WebSocket.
 */

import { DICTS, DEFAULT_LOCALE, translate } from './i18n/index.js';
import { renderMarkdown } from './markdown.js';
import { APP_NAME } from './appName.js';
import { APP_VERSION } from './appVersion.js';
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, nameGeneratorFor, providerDisplayFor } from './agentProviders.js';
import { AUTOCOMPACT_PRESETS } from './autocompact.js';

// ─── Types (JSDoc only) ─────────────────────────────────────────────────────

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} workingDir
 * @property {string} provider - Which CLI the agent runs as (see agentProviders.js)
 * @property {string} [resumeId] - Optional --resume session ID for that CLI
 * @property {boolean} [dangerouslySkipPermissions] - "YOLO mode"
 * @property {boolean} [isObserver] - Never responds to broadcast messages,
 *   only @mentions — sees the full chat history instead of the recent window
 * @property {string} [note] - Freeform reminder for the user, why this agent exists
 * @property {string} [model] - Real model ID the CLI reported running on this
 *   agent's most recent turn (e.g. "claude-sonnet-5") — purely observational,
 *   reflects whatever the CLI actually ran on. Absent until the agent's first turn.
 * @property {string} [modelOverride] - User-requested model ("opus", "sonnet",
 *   a full model ID, …), passed to the CLI as `--model`. Absent means the CLI
 *   decides on its own.
 * @property {string} [autocompactOverride] - This agent's own context-compaction
 *   window ("auto", "200k", …), passed to the CLI as `--autocompact`. Absent
 *   means the Settings default applies (see effectiveDefaultAutocompact).
 * @property {number} cumulativeCostUsd - All-time running total cost (USD)
 *   across EVERY chat this agent has ever been part of, not just the one
 *   it's currently in — see formatUsageLabel, which is what actually labels
 *   this as all-time in the UI. Successful and errored turns both count. 0
 *   for a brand-new agent.
 * @property {number} [lastTurnCostUsd] - Cost (USD) of just this agent's
 *   most recent turn — overwritten each turn, unlike cumulativeCostUsd
 *   which only grows. Absent until the agent's first turn.
 * @property {number} [lastContextTokens] - The agent's session context size
 *   as of its most recent turn's last model request — what each request of
 *   its next turn will read back before producing anything new. Absent until the
 *   agent's first turn — see formatUsageLabel.
 * @property {string} [sessionLimitResetAt] - ISO 8601 instant Claude's own
 *   session-limit error most recently said this agent's limit resets at.
 *   Cleared server-side on this agent's next successful turn, so its
 *   presence means the agent is (or very recently was) still limited.
 * @property {string} createdAt
 */

/**
 * @typedef {Object} Chat
 * @property {string} id
 * @property {string} name
 * @property {string[]} memberAgentIds
 * @property {boolean} freeRelay - When true, an agent's @mention of a
 *   teammate in a reply keeps relaying round after round instead of
 *   stopping after one hop — see the #free-relay-btn toggle and the relay
 *   loop in server/ws/handler.js.
 * @property {boolean} autoContinue - When true, an agent hitting Claude's
 *   own session-limit error auto-schedules a "please continue" message for
 *   one minute after the limit resets — see the #auto-continue-btn toggle
 *   and maybeScheduleAutoContinue in server/ws/handler.js.
 * @property {string | null} category - Freeform label for grouping this
 *   chat in the sidebar, or null if uncategorized.
 * @property {string} createdAt
 */

/**
 * @typedef {'user'|'agent'} MessageRole
 */

/**
 * @typedef {Object} Attachment
 * @property {string} id
 * @property {'image'|'text'} type
 * @property {string} [mediaType] - MIME type, images only (e.g. "image/png")
 * @property {string} [name] - Filename or a label like "Pasted text #1 (+40 lines)"
 * @property {string} data - Base64 (image) or raw text (text paste)
 * @property {number} [size]
 */

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} chatId
 * @property {MessageRole} role
 * @property {string|null} agentId
 * @property {string} authorName
 * @property {string} content
 * @property {Attachment[]} [attachments]
 * @property {import('../services/agentProcessManager.js').ToolCall[]} [toolCalls]
 * @property {boolean} [isSystemNote] - An informational aside about the
 *   agent (currently just a context-compaction report), not something it
 *   actually said — rendered without an avatar/bubble, see buildMessageEl.
 * @property {string} createdAt
 */

/**
 * @typedef {Object} ScheduledMessage
 * @property {string} id
 * @property {string} chatId
 * @property {string} content
 * @property {Attachment[]} attachments
 * @property {string} sendAt
 * @property {string} createdAt
 */

/**
 * @typedef {Object} QuickMessage
 * @property {string} id
 * @property {string} text
 * @property {string} createdAt
 */

/**
 * Tracks one in-progress agent turn's accumulated state independent of
 * whether its chat is the one currently on screen — a turn keeps streaming
 * server-side no matter which chat the user is looking at, so the data
 * fields below (rawText/statusText/typingHidden/startedAt) are always kept
 * current. The DOM fields are only populated while `chatId` is the active
 * chat: selectChat attaches them (attachStreamingBubble) when switching into
 * this stream's chat and detaches them (detachStreamingBubble) when
 * switching away, without touching the data fields.
 * @typedef {Object} StreamingEntry
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} agentName
 * @property {string} agentColor
 * @property {number} startedAt
 * @property {string} rawText - full accumulated response text so far
 * @property {string} statusText - last live "what's happening" status line
 * @property {boolean} typingHidden - true while the "responding…"/status row
 *   is hidden because text is actively streaming. Not one-way: a tool call
 *   or subagent delegation that interrupts the text re-shows the row (see
 *   onStreamStatus/showStreamStatus), and the next chunk of text hides it
 *   again (onStreamChunk/stopStreamStatus).
 * @property {HTMLElement} [el]   - The .msg DOM element, present only while `chatId` is the active chat
 * @property {HTMLElement} [body] - The .msg-content text node container
 * @property {HTMLElement} [typingEl]
 * @property {HTMLElement} [statusTextEl]
 * @property {HTMLElement} [elapsedEl]
 * @property {ReturnType<typeof setInterval>} [timerId]
 */

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Agent[]} */
let agents = [];

/** @type {Chat[]} */
let chats = [];

/** @type {string|null} */
let activeChatId = null;

/**
 * Chat IDs with an agent reply the user hasn't seen yet — purely a
 * live-session signal, not persisted server-side or across a reload. An
 * agent message arriving for a chat that isn't the active one adds it here
 * (see onStreamEnd); selecting a chat clears it. Only agent messages count
 * — the user's own messages are inherently already "seen" as they type them.
 * @type {Set<string>}
 */
const unreadChatIds = new Set();

/**
 * Agent IDs currently "spotlighted" via the agent panel's filter toggle —
 * when non-empty, only messages from these agents stay visible, plus the
 * user's own messages that are actually relevant to them: a broadcast (no
 * @mention) or one that @mentions a spotlighted agent. A user message
 * @mentioning someone else entirely (e.g. a private aside to a different
 * teammate) is hidden like anything else unrelated — see
 * isVisibleUnderMessageFilter. Everything hidden (other agents' messages,
 * their streaming bubbles, their permission cards) is hidden in-place rather
 * than re-fetched. Empty = show everything (the default). Resets whenever
 * the active chat changes (see selectChat) — a filter scoped to one chat's
 * roster carrying over to an unrelated chat would be confusing, not
 * convenient.
 * @type {Set<string>}
 */
const messageFilterAgentIds = new Set();

/**
 * Agent IDs with a message that arrived, in the active chat, while the
 * message filter was spotlighting OTHER agents — the "you might have missed
 * this while focused on someone else" signal. Purely a live-session
 * annotation, same as unreadChatIds: never persisted, and cleared the
 * moment that agent gets spotlighted (their messages become visible again,
 * see toggleMessageFilter) or the filter is cleared entirely (see
 * clearMessageFilter) or the active chat changes (see selectChat).
 * @type {Set<string>}
 */
const unseenOutsideFocusAgentIds = new Set();

/** @type {number} bumped on every search-input keystroke; guards against an
 * older in-flight search response overwriting a newer one, same pattern as
 * browseRequestId. */
let searchRequestId = 0;

/** @type {ReturnType<typeof setTimeout> | null} debounce handle for search input */
let searchDebounceTimer = null;

/** Whether the message list currently shows a jumped-to context window
 * (from a search result) rather than the normal tail-of-chat view loaded by
 * selectChat — drives the "back to latest" banner.
 * @type {boolean} */
let isViewingSearchContext = false;

/**
 * Forum-thread-style pagination state for the active chat's normal (not
 * search-context) message view — see loadMessagesPage. Page 1 is the
 * chat's oldest messages; currentPage === totalPages means "viewing the
 * latest page," which is the only state live WS events (onMessageSaved,
 * onStreamStart) render into — see isViewingLatestPage. Both reset to 1
 * whenever loadMessagesPage runs, so they're never stale for a chat that
 * hasn't been loaded yet.
 * @type {number}
 */
let currentPage = 1;
/** @type {number} */
let totalPages = 1;

/** @type {string} currently selected color in the create-agent modal */
let selectedColor = '#89b4fa';

/** @type {string} currently selected color in the settings modal's message-color picker */
let selectedUserColor = '#a6adc8';

/** @type {string | null} id of the agent whose note the note modal is currently editing */
let noteEditAgentId = null;

/** @type {string | null} id of the agent whose saved permissions the grants modal is showing */
let grantsAgentId = null;

/**
 * @typedef {Object} Settings
 * @property {string} userDisplayName
 * @property {string} userColor - Hex color string, e.g. "#a6adc8"
 * @property {string} locale - UI language, e.g. "en-CA" or "fr-CA"
 * @property {string} theme - UI theme, "dark" or "light"
 * @property {string} defaultAutocompact - Compaction window for agents with no
 *   override of their own, '' when unset
 * @property {string} autocompactFallback - What applies when
 *   defaultAutocompact is unset (the server's APP_AUTOCOMPACT, or its built-in default)
 */

/** @type {Settings} */
let userSettings = { userDisplayName: 'You', userColor: '#a6adc8', locale: DEFAULT_LOCALE, theme: 'dark', defaultAutocompact: '', autocompactFallback: '200k' };

/**
 * The compaction window an agent with no override of its own runs with.
 * @returns {string}
 */
function effectiveDefaultAutocompact() {
  return userSettings.defaultAutocompact || userSettings.autocompactFallback;
}

/** @type {string} the UI's currently active language */
let currentLocale = DEFAULT_LOCALE;

/**
 * Translates `key` in the current locale, interpolating `params` — see
 * translate() in ./i18n/index.js for the exact lookup/pluralization rules.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
function t(key, params) {
  return translate(DICTS[currentLocale] ?? DICTS[DEFAULT_LOCALE], key, params);
}

/**
 * Applies the current locale to every statically-marked element in the DOM
 * (data-i18n/-placeholder/-title/-html) and syncs <html lang>. Elements whose
 * text is set imperatively elsewhere (e.g. #conn-dot's title, toggled on
 * ws.onopen/onclose) aren't covered here — those call sites call t() directly
 * so a locale switch mid-connection doesn't need a reconnect to take effect.
 */
function applyTranslations() {
  document.documentElement.lang = currentLocale;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

/**
 * Applies `theme` to the document root (style.css keys its light palette off
 * `:root[data-theme="light"]`, dark is the attribute-less default) and
 * caches it in localStorage so a page reload's inline snippet in
 * index.html's `<head>` can apply a saved light preference before first
 * paint, instead of flashing dark (the default) until the async
 * /api/settings fetch in init() resolves and corrects it.
 * @param {string} theme - "dark" or "light"
 * @returns {void}
 */
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('theme', theme);
}

// ─── Responsive drawers (narrow viewports) ─────────────────────────────────
// Below the breakpoints in style.css, #sidebar/#agent-panel come out of the
// normal flex layout and become off-canvas panels — CSS handles the actual
// slide animation via the .drawer-open class, this just owns which one (if
// any) is currently open. Only one at a time: opening the other closes
// whichever was open, so the shared backdrop's "click to close" has a single
// unambiguous target instead of needing to track a set.

/** @type {HTMLElement | null} #sidebar or #agent-panel, whichever is currently open as a drawer. */
let openDrawerEl = null;

/**
 * Closes whichever drawer is open, if any. Safe to call unconditionally
 * (e.g. on Escape, or a chat being selected) even when nothing is open.
 * @returns {void}
 */
function closeDrawer() {
  if (!openDrawerEl) return;
  openDrawerEl.classList.remove('drawer-open');
  openDrawerEl = null;
  drawerBackdrop.hidden = true;
}

/**
 * Opens `el` as a drawer, closing any other drawer first (see openDrawerEl's
 * docs) — a no-op re-click on the SAME panel's toggle button closes it
 * instead, handled by toggleDrawer below rather than here.
 * @param {HTMLElement} el
 * @returns {void}
 */
function openDrawer(el) {
  if (openDrawerEl && openDrawerEl !== el) closeDrawer();
  openDrawerEl = el;
  el.classList.add('drawer-open');
  drawerBackdrop.hidden = false;
}

/**
 * Wired to both toggle buttons — clicking the button for the already-open
 * drawer closes it, clicking the other one's switches directly.
 * @param {HTMLElement} el
 * @returns {void}
 */
function toggleDrawer(el) {
  if (openDrawerEl === el) closeDrawer();
  else openDrawer(el);
}

// ─── Contrast-safe agent/user colors ───────────────────────────────────────
// PRESET_COLORS (below) is a fixed set of pastel hexes tuned to read well as
// text/avatar-fill against the DARK theme's near-black --bg0. The light
// theme's --bg0 is near-white, so those same pastels (and any custom hex
// stored before this existed) can land well under WCAG contrast there — the
// exact "agent color barely readable in light mode" bug this section fixes.
// Rather than a second theme-specific palette (which wouldn't help colors
// already saved on existing agents), every render site nudges the stored
// color's LIGHTNESS toward black/white, preserving hue, until it contrasts
// enough against the CURRENT theme's --bg0 — a color already safe (e.g. any
// dark-theme pastel against dark --bg0) round-trips unchanged.

/** Minimum WCAG contrast ratio targeted for agent/user color text and avatar fills. */
const MIN_COLOR_CONTRAST = 4.5;

/**
 * @param {string} hex - "#rrggbb"
 * @returns {{r: number, g: number, b: number}}
 */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** @param {{r: number, g: number, b: number}} rgb */
function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

/**
 * WCAG relative luminance (0 = black, 1 = white).
 * @param {{r: number, g: number, b: number}} rgb
 * @returns {number}
 */
function relativeLuminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG contrast ratio between two hex colors, from 1 (identical) to 21
 * (black vs white).
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {{r: number, g: number, b: number}} rgb
 * @returns {{h: number, s: number, l: number}} each in [0, 1]
 */
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h / 6, s, l };
}

/** @param {{h: number, s: number, l: number}} hsl */
function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255 };
}

/**
 * Returns `hex` unchanged if it already contrasts enough against `bgHex`,
 * otherwise nudges its HSL lightness toward black (if `bgHex` is light) or
 * white (if `bgHex` is dark) — hue and saturation untouched — by the least
 * amount that clears `minRatio`. Binary search over lightness rather than a
 * fixed step: the two theme backgrounds are extreme enough (near-black /
 * near-white) that the darkest/lightest end of the search always clears
 * ordinary text-contrast thresholds, so this always converges.
 * @param {string} hex
 * @param {string} bgHex
 * @param {number} [minRatio]
 * @returns {string}
 */
function ensureContrast(hex, bgHex, minRatio = MIN_COLOR_CONTRAST) {
  if (contrastRatio(hex, bgHex) >= minRatio) return hex;

  const hsl = rgbToHsl(hexToRgb(hex));
  const bgIsLight = relativeLuminance(hexToRgb(bgHex)) > 0.5;
  const passes = (l) => contrastRatio(rgbToHex(hslToRgb({ ...hsl, l })), bgHex) >= minRatio;

  // Light bg: darken toward 0, contrast rises monotonically as l falls, so
  // the passing region is [0, l*] — binary-search for that upper boundary,
  // the least-dark passing lightness. Dark bg: mirror image, lighten toward
  // 1, passing region is [l*, 1], search for its lower boundary.
  let lo, hi;
  if (bgIsLight) {
    lo = 0; // passes (black vs light bg)
    hi = hsl.l; // fails (already established above)
  } else {
    lo = hsl.l; // fails
    hi = 1; // passes (white vs dark bg)
  }
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid) === bgIsLight) {
      // bgIsLight: mid passes → it's a valid (and less-dark) new boundary.
      // !bgIsLight: mid fails → still need to go lighter.
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return rgbToHex(hslToRgb({ ...hsl, l: bgIsLight ? lo : hi }));
}

/**
 * Resolves a stored agent/user hex color to what should actually be
 * rendered right now — contrast-corrected (see ensureContrast) against the
 * CURRENT theme's --bg0, which is also the literal background every avatar
 * (.msg-avatar/.agent-avatar/.mention-avatar/.add-menu-avatar) sits on and
 * fills with var(--bg0) text, and a close proxy for the message bubble's own
 * background (--bg0 lightly tinted by the color itself). One reference
 * background covers both roles since each just needs "this color" and
 * "--bg0" to contrast, regardless of which one is foreground vs background.
 * Passed through unchanged if it isn't a plain "#rrggbb" (e.g. the
 * `var(--muted)` fallback for a since-deleted agent — already theme-safe by
 * construction).
 * @param {string} hex
 * @returns {string}
 */
function agentDisplayColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const bg0 = getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim();
  return ensureContrast(hex, bg0);
}

/** @type {Record<string, StreamingEntry>} keyed by streamId */
const streamingEntries = {};

/**
 * Each agent's still-running background tasks (e.g. a backgrounded Bash
 * command), as last reported by an AGENT_BACKGROUND_TASKS event — an agent
 * with none simply has no entry. Shown as a badge in the agent panel so an
 * agent that ended its turn with "I'll wait for that to finish" doesn't look
 * exactly like one that's done.
 * @type {Map<string, { id: string, type: string, description: string }[]>}
 */
const backgroundTasksByAgentId = new Map();

/** @type {Attachment[]} pending attachments for the message currently being composed */
let pendingAttachments = [];

/** @type {ScheduledMessage[]} pending scheduled messages for the active chat */
let pendingScheduledMessages = [];

/** @type {QuickMessage[]} saved quick messages — global, loaded once at init */
let quickMessages = [];

/** @type {Attachment[]} the schedule modal's own attachment set — decoupled
 *  from pendingAttachments so editing a pending scheduled message's
 *  attachments never touches whatever's independently in the composer */
let scheduleModalAttachments = [];

/** @type {string | null} id of the scheduled message the modal is currently
 *  editing, or null when it's composing a brand new one */
let editingScheduledId = null;

let pasteTextCounter = 0;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const PASTE_TEXT_CHAR_THRESHOLD = 800;
const PASTE_TEXT_LINE_THRESHOLD = 20;

/** @type {WebSocket|null} */
let ws = null;

let wsBackoff = 1000;
const MAX_BACKOFF = 30_000;

const PRESET_COLORS = [
  '#89b4fa', '#a6e3a1', '#fab387', '#f38ba8',
  '#cba6f7', '#f9e2af', '#89dceb', '#b4befe',
];

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = /** @param {string} sel */ (sel) => document.querySelector(sel);

const appTitleEl       = $('#app-title');
const appVersionEl     = $('#app-version');
const connDot          = $('#conn-dot');
const chatList         = $('#chat-list');
const newChatBtn       = $('#new-chat-btn');
const newChatForm      = $('#new-chat-form');
const newChatInput     = $('#new-chat-input');
const emptyState       = $('#empty-state');
const chatView         = $('#chat-view');
const chatTopbarName   = $('#chat-topbar-name');
const freeRelayBtn     = $('#free-relay-btn');
const autoContinueBtn  = $('#auto-continue-btn');
const reconnNotice     = $('#reconnecting-notice');
const sidebarEl        = $('#sidebar');
const sidebarToggleBtn = $('#sidebar-toggle-btn');
const agentPanelEl     = $('#agent-panel');
const agentPanelToggleBtn = $('#agent-panel-toggle-btn');
const drawerBackdrop   = $('#drawer-backdrop');
const messageFilterBar = $('#message-filter-bar');
const searchBtn        = $('#search-btn');
const searchBar        = $('#search-bar');
const searchInput      = $('#search-input');
const searchClose      = $('#search-close');
const searchResultsEl  = $('#search-results');
const jumpedBanner     = $('#jumped-banner');
const jumpedBannerBackBtn = $('#jumped-banner-back-btn');
const staleAutoContinueBanner = $('#stale-auto-continue-banner');
const pageNav          = $('#page-nav');
const chatHeaderCollapseBtn = $('#chat-header-collapse-btn');
const chatHeaderExpandBtn = $('#chat-header-expand-btn');
const sidebarCollapseBtn = $('#sidebar-collapse-btn');
const sidebarExpandBtn = $('#sidebar-expand-btn');
const agentPanelCollapseBtn = $('#agent-panel-collapse-btn');
const agentPanelExpandBtn = $('#agent-panel-expand-btn');
const pageFirstBtn     = $('#page-first-btn');
const pagePrevBtn      = $('#page-prev-btn');
const pageIndicator    = $('#page-indicator');
const pageNextBtn      = $('#page-next-btn');
const pageLastBtn      = $('#page-last-btn');
const messageList      = $('#message-list');
const typingBar        = $('#typing-bar');
const msgInput         = $('#msg-input');
const scheduleBtn      = $('#schedule-btn');
const micBtn           = $('#mic-btn');
const sendBtn          = $('#send-btn');
const mentionDropdown  = $('#mention-dropdown');
const scheduledBtn     = $('#scheduled-btn');
const scheduledPanel   = $('#scheduled-panel');
const quickMsgBtn      = $('#quick-msg-btn');
const quickMsgPanel    = $('#quick-msg-panel');
const scheduleOverlay  = $('#schedule-overlay');
const scheduleTitleEl  = $('#schedule-title');
const scheduleClose    = $('#schedule-close');
const scheduleForm     = $('#schedule-form');
const scheduleContentInput = $('#schedule-content-input');
const scheduleAttachmentChips = $('#schedule-attachment-chips');
const scheduleTimeInput = $('#schedule-time-input');
const scheduleError    = $('#schedule-error');
const scheduleCancel   = $('#schedule-cancel');
const scheduleSubmit   = $('#schedule-submit');
const attachmentChips  = $('#attachment-chips');
const attachmentError  = $('#attachment-error');
const inputArea        = $('#input-area');
const agentList        = $('#agent-list');
const agentActions     = $('#agent-actions');
const noChatNotice     = $('#no-chat-notice');
const addAgentBtn      = $('#add-agent-btn');
const addAgentMenu     = $('#add-agent-menu');
const agentPanelError  = $('#agent-panel-error');
const newAgentBtn      = $('#new-agent-btn');
const modalOverlay     = $('#modal-overlay');
const modalClose       = $('#modal-close');
const modalCancel      = $('#modal-cancel');
const agentForm        = $('#agent-form');
const agentNameInput   = $('#agent-name');
const agentNameGenerateBtn = $('#agent-name-generate');
const agentDirInput    = $('#agent-dir');
const agentDirBrowseBtn = $('#agent-dir-browse');
const agentDirRecent   = $('#agent-dir-recent');
const agentDirRecentWrap = $('#agent-dir-recent-wrap');
const agentProviderSelect = $('#agent-provider');
const agentProviderStatus = $('#agent-provider-status');
const agentResumeInput = $('#agent-resume');
const agentResumeHint  = $('#agent-resume-hint');
const agentModelInput  = $('#agent-model');
const agentModelCustomInput = $('#agent-model-custom');
const agentModelHint   = $('#agent-model-hint');
const agentAutocompactInput = $('#agent-autocompact');
const agentAutocompactLabel = $('#agent-autocompact-label');
const agentNoteInput   = $('#agent-note');
const colorGrid        = $('#color-grid');
const yoloModeCheck    = $('#yolo-mode-check');
const observerModeCheck = $('#observer-mode-check');
const chromeAccessCheck = $('#chrome-access-check');
const chromeAccessLabel = $('#chrome-access-label');
const addToChatLabel   = $('#add-to-chat-label');
const addToChatCheck   = $('#add-to-chat-check');
const agentError       = $('#agent-error');
const modalSubmit      = $('#modal-submit');
const browseOverlay    = $('#browse-overlay');
const browseClose      = $('#browse-close');
const browsePathInput  = $('#browse-path-input');
const browsePathGo     = $('#browse-path-go');
const browseError      = $('#browse-error');
const browseList       = $('#browse-list');
const browseCancel     = $('#browse-cancel');
const browseSelect     = $('#browse-select');
const noteOverlay      = $('#note-overlay');
const noteHeaderTitle  = $('#note-header-title');
const noteClose        = $('#note-close');
const noteForm         = $('#note-form');
const noteTextarea     = $('#note-textarea');
const noteCancel       = $('#note-cancel');
const grantsOverlay    = $('#grants-overlay');
const grantsHeaderTitle = $('#grants-header-title');
const grantsClose      = $('#grants-close');
const grantsList       = $('#grants-list');
const grantsEmpty      = $('#grants-empty');
const confirmOverlay   = $('#confirm-overlay');
const confirmMessage   = $('#confirm-message');
const confirmCheckboxRow   = $('#confirm-checkbox-row');
const confirmCheckbox      = $('#confirm-checkbox');
const confirmCheckboxLabel = $('#confirm-checkbox-label');
const confirmTextRow       = $('#confirm-text-row');
const confirmTextInput     = $('#confirm-text-input');
const confirmModelRow      = $('#confirm-model-row');
const confirmModelSelect   = $('#confirm-model-select');
const confirmModelCustomInput = $('#confirm-model-custom-input');
const confirmCancel    = $('#confirm-cancel');
const confirmOk        = $('#confirm-ok');
const imageLightboxOverlay = $('#image-lightbox-overlay');
const imageLightboxImg = $('#image-lightbox-img');
const appLogo          = $('#app-logo');
const settingsBtn      = $('#settings-btn');
const settingsOverlay  = $('#settings-overlay');
const settingsClose    = $('#settings-close');
const settingsCancel   = $('#settings-cancel');
const settingsForm     = $('#settings-form');
const settingsDisplayNameInput = $('#settings-display-name');
const settingsColorGrid = $('#settings-color-grid');
const settingsLanguageSelect = $('#settings-language');
const settingsThemeSelect = $('#settings-theme');
const settingsAutocompactInput = $('#settings-autocompact');
const settingsError    = $('#settings-error');
const settingsSave     = $('#settings-save');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the short display path (last two segments).
 * @param {string} dir
 * @returns {string}
 */
function shortDir(dir) {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : dir;
}

/**
 * Above this many tokens, an agent's most recent lastContextTokens (see its
 * docs in server/store/db.js) gets a visually distinct warning treatment in
 * the agent panel — this is past the point where --autocompact's default
 * 200k window (agentProcessManager.js's AUTOCOMPACT_WINDOW) should have
 * already stepped in, so a badge still showing this much is worth a second
 * look, not just background info. Not a hard limit of any kind — purely a
 * display threshold.
 */
const USAGE_HIGH_CONTEXT_TOKENS = 300_000;

/**
 * Formats an agent's cost + last-turn context size for the agent panel's
 * usage badge, split into two short lines instead of one long run-on
 * sentence: a `primary` line ("$12.45 all-time") and a `secondary` line
 * ("+$0.03 last turn · 9.7M ctx"). Splitting it is deliberate — the agent
 * panel is only ~240px wide, and a single-string label long enough to spell
 * out "all-time"/"last turn" in full would otherwise wrap at arbitrary
 * character boundaries (mid-word, mid-number) rather than at a clean
 * line break; returning two pre-split, independently-truncatable parts
 * lets the CSS put the break exactly between them instead. The literal
 * "all-time" and "last turn" words are still spelled out — not left to the
 * title tooltip alone — because cumulativeCostUsd is genuinely a lifetime
 * total across every chat this agent has ever been part of (see its docs in
 * server/store/db.js), and that scope needs to be unambiguous at a glance
 * rather than only discoverable on hover. lastTurnCostUsd is what answers
 * "why did the all-time total just jump." Token counts are rounded to one
 * decimal place at the nearest K/M so the label stays short — this is a
 * rough sense of scale, not an exact accounting (formatUsageExact has the
 * precise numbers, shown in the tooltip).
 * @param {number} cumulativeCostUsd
 * @param {number} [lastTurnCostUsd]
 * @param {number} [lastContextTokens]
 * @returns {{ primary: string, secondary: string }}
 */
function formatUsageLabel(cumulativeCostUsd, lastTurnCostUsd, lastContextTokens) {
  const primary = `$${cumulativeCostUsd.toFixed(2)} all-time`;
  const turn = lastTurnCostUsd != null ? `+$${lastTurnCostUsd.toFixed(2)} last turn` : '';
  const tokens = lastContextTokens == null ? '' : lastContextTokens >= 1_000_000
    ? `${(lastContextTokens / 1_000_000).toFixed(1)}M ctx`
    : lastContextTokens >= 1_000
      ? `${(lastContextTokens / 1_000).toFixed(1)}K ctx`
      : `${lastContextTokens} ctx`;
  const secondary = [turn, tokens].filter(Boolean).join(' · ');
  return { primary, secondary };
}

/**
 * Formats the same three fields as formatUsageLabel, but at full precision
 * (4 decimal places on cost, exact token count with thousands separators)
 * for the usage badge's tooltip. formatUsageLabel's own rounding (2 decimals,
 * K/M-scaled tokens) is deliberately a rough-scale label for the badge
 * itself — this is the "how is this actually calculated" answer that only
 * shows up on hover, so it should show real numbers rather than repeat the
 * same rounding.
 * @param {number} cumulativeCostUsd
 * @param {number} [lastTurnCostUsd]
 * @param {number} [lastContextTokens]
 * @returns {string}
 */
function formatUsageExact(cumulativeCostUsd, lastTurnCostUsd, lastContextTokens) {
  const cost = `$${cumulativeCostUsd.toFixed(4)} all-time`;
  const turn = lastTurnCostUsd != null ? `, +$${lastTurnCostUsd.toFixed(4)} last turn` : '';
  const tokens = lastContextTokens != null ? `, ${lastContextTokens.toLocaleString()} context tokens` : '';
  return `${cost}${turn}${tokens}`;
}

/**
 * Builds the agent panel's 💰 usage badge markup, or '' for an agent with no
 * cost yet (cumulativeCostUsd === 0). Pulled out of the agent-card template
 * literal because it's no longer a single interpolated string — see
 * formatUsageLabel for why it's two lines (primary/secondary) instead of one.
 * @param {Agent} agent
 * @returns {string}
 */
function renderUsageBadge(agent) {
  if (!(agent.cumulativeCostUsd > 0)) return '';
  const isHigh = (agent.lastContextTokens ?? 0) > USAGE_HIGH_CONTEXT_TOKENS;
  const exact = formatUsageExact(agent.cumulativeCostUsd, agent.lastTurnCostUsd, agent.lastContextTokens);
  const title = isHigh ? t('agent.usageHighTitle', { exact }) : t('agent.usageTitle', { exact });
  const { primary, secondary } = formatUsageLabel(agent.cumulativeCostUsd, agent.lastTurnCostUsd, agent.lastContextTokens);
  return `<span class="agent-usage${isHigh ? ' agent-usage-high' : ''}" data-testid="agent-usage" title="${title}">
    <span class="agent-usage-primary">💰 ${primary}</span>
    ${secondary ? `<span class="agent-usage-secondary">${secondary}</span>` : ''}
  </span>`;
}

/**
 * Whether an agent's session-limit badge should still show — sessionLimitResetAt
 * is cleared server-side on the agent's next successful turn, but a stale
 * (already-passed) instant can otherwise briefly linger client-side between
 * that clear and the next AGENT_UPDATED reaching this tab; treated the same
 * as "no badge" rather than showing a reset time that's already in the past.
 * @param {Agent} agent
 * @returns {boolean}
 */
function isSessionLimited(agent) {
  return !!agent.sessionLimitResetAt && new Date(agent.sessionLimitResetAt) > new Date();
}

/**
 * "Runs as Claude Code", as an escaped title attribute value. Where space
 * is tight (agent panel, add menu, @mention popup) an agent's provider is
 * only this tooltip on its name.
 * @param {Agent} agent
 * @returns {string}
 */
function providerTitle(agent) {
  return escHtml(t('agent.providerBadgeTitle', { provider: providerDisplayFor(agent.provider).label }));
}

/**
 * The "(claude)" after an agent's name in a message header, naming which
 * CLI it runs as, so agents of different providers aren't mixed up.
 * @param {Agent} agent
 * @param {string} className
 * @returns {string} HTML
 */
function renderProviderBadge(agent, className) {
  const display = providerDisplayFor(agent.provider);
  return ` <span class="${className}" data-testid="${className}" title="${providerTitle(agent)}">(${escHtml(display.tag)})</span>`;
}

/**
 * Fits a model-family `<select>` (+ its companion "Custom" text input) to a
 * provider: only that provider's own aliases are offered (see
 * ProviderDisplay.modelAliases in agentProviders.js), or, for a provider
 * with none, the model IDs it listed (see fetchProviderModels). With
 * neither, the exact-ID input is shown on its own.
 * @param {HTMLSelectElement} select
 * @param {HTMLInputElement} customInput
 * @param {import('./agentProviders.js').ProviderDisplay} display
 * @param {string[]} [models] - Listed model IDs, for a provider with no aliases.
 */
function configureModelPicker(select, customInput, display, models = []) {
  const aliases = display.modelAliases ?? [];
  for (const option of [...select.options]) {
    if (option.dataset.listed) option.remove();
    else if (option.value === '') option.textContent = t('agentModal.modelDefaultOption', { provider: display.label });
    else if (option.value !== 'custom') option.hidden = !aliases.includes(option.value);
  }
  const custom = select.querySelector('option[value="custom"]');
  for (const model of display.modelAliases ? [] : models) {
    const option = new Option(model, model);
    option.dataset.listed = 'true';
    select.insertBefore(option, custom);
  }
  select.hidden = !display.modelAliases && !models.length;
  customInput.placeholder = t('agentModal.modelCustomPlaceholder', { model: display.modelExample });
}

/**
 * Prefills a model-family `<select>` (+ its companion "Custom" text input)
 * from an arbitrary modelOverride string — a known alias or listed model
 * selects directly; any other non-empty value (a full pinned model ID)
 * falls into the Custom option with that value shown in the companion
 * input. With nothing to pick from, it always uses the Custom input (see
 * configureModelPicker).
 * @param {HTMLSelectElement} select
 * @param {HTMLInputElement} customInput
 * @param {string} value
 * @param {import('./agentProviders.js').ProviderDisplay} display
 * @param {string[]} [models] - Listed model IDs, for a provider with no aliases.
 */
function setModelSelectValue(select, customInput, value, display, models = []) {
  configureModelPicker(select, customInput, display, models);
  const known = display.modelAliases ?? models;
  if (select.hidden) {
    select.value = 'custom';
    customInput.hidden = false;
    customInput.value = value;
  } else if (value === '' || known.includes(value)) {
    select.value = value;
    customInput.hidden = true;
    customInput.value = '';
  } else {
    select.value = 'custom';
    customInput.hidden = false;
    customInput.value = value;
  }
}

/**
 * Model lists by provider and working directory, so reopening the form or
 * the model switcher doesn't rerun the provider's CLI. A failed listing
 * isn't kept, so the next open tries again.
 * @type {Map<string, Promise<string[]>>}
 */
const providerModelsCache = new Map();

/**
 * The model IDs a provider with no aliases of its own can run in a working
 * directory (GET /api/providers/:id/models), for its model picker. Empty
 * when it has none to list or listing failed: the exact-ID input still
 * takes any model.
 * @param {string} providerId
 * @param {string} [workingDir]
 * @returns {Promise<string[]>}
 */
function fetchProviderModels(providerId, workingDir = '') {
  if (providerDisplayFor(providerId).modelAliases) return Promise.resolve([]);
  const key = `${providerId}\n${workingDir}`;
  if (!providerModelsCache.has(key)) {
    const query = workingDir ? `?workingDir=${encodeURIComponent(workingDir)}` : '';
    providerModelsCache.set(key, fetch(`/api/providers/${encodeURIComponent(providerId)}/models${query}`)
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then(({ models }) => {
        if (!models?.length) providerModelsCache.delete(key);
        return models ?? [];
      })
      .catch(() => {
        providerModelsCache.delete(key);
        return [];
      }));
  }
  return providerModelsCache.get(key);
}

/**
 * Reads the resolved modelOverride value back out of a model-family
 * `<select>` (+ companion "Custom" input) pair set up by setModelSelectValue.
 * @param {HTMLSelectElement} select
 * @param {HTMLInputElement} customInput
 * @returns {string}
 */
function getModelSelectValue(select, customInput) {
  return select.value === 'custom' ? customInput.value.trim() : select.value;
}

/**
 * Formats an ISO timestamp for display in the message list. Time-only for
 * today (e.g. "2:15 PM") — otherwise the date is included too (e.g. "Aug 2,
 * 2:15 PM", or "Aug 2, 2024, 2:15 PM" once it's from a previous year), so a
 * conversation spanning multiple days doesn't read as "confusing" — every
 * message's own timestamp says which day it's from, not just the time.
 * "Today" is evaluated at call time in the browser's local timezone, so a
 * message rendered before midnight won't retroactively grow a date once
 * it's no longer "today" — same as this app's other live timestamps, not
 * worth a midnight-tick timer to correct.
 * @param {string} iso
 * @returns {string}
 */
function fmtTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' });
  }
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleString(currentLocale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats an ISO timestamp for a scheduled message's send time. Unlike
 * fmtTime, always shows the full date — a future send time doesn't have
 * the same "today, so time alone is unambiguous" shortcut a past message's
 * timestamp does.
 * @param {string} iso
 * @returns {string}
 */
function fmtScheduledTime(iso) {
  const date = new Date(iso);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleString(currentLocale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Full date, time and time zone for a tooltip, where fmtScheduledTime's
 * compact form may be cut off by an ellipsis.
 * @param {string} iso
 * @returns {string}
 */
function fmtFullTime(iso) {
  return new Date(iso).toLocaleString(currentLocale, { dateStyle: 'full', timeStyle: 'long' });
}

/**
 * Converts an ISO timestamp to the local-time value string a
 * datetime-local input (step="1") expects — the inverse of reading
 * `new Date(input.value).getTime()` back out at submit time. Used to
 * prefill the schedule modal's time field when editing a pending message.
 * @param {string} iso
 * @returns {string}
 */
function toDatetimeLocalValue(iso) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

/**
 * Finds an agent by ID from the local state.
 * @param {string} id
 * @returns {Agent|undefined}
 */
function agentById(id) {
  return agents.find((a) => a.id === id);
}

/**
 * Returns the active chat object.
 * @returns {Chat|undefined}
 */
function activeChat() {
  return chats.find((c) => c.id === activeChatId);
}

/** @type {((confirmed: boolean) => void) | null} resolver for the in-flight confirmDialog() call, if any */
let pendingConfirmResolve = null;

/**
 * Shows the generic confirmation modal with the given message and resolves
 * once the user picks Cancel or Delete. Used to gate irreversible actions
 * (deleting a chat or an agent) behind an explicit step. When
 * `checkboxLabel` is given, an extra opt-in checkbox is shown beneath the
 * message (e.g. "also delete its agents") and its final state is returned
 * alongside the confirm/cancel choice; otherwise the row stays hidden and
 * `checked` is always false. When `textInput` is given, an extra text field
 * (pre-filled with `textInput.value`) is shown instead — used for renaming a
 * category, where the confirm action needs a new name, not just a yes/no.
 * When `modelInput` is given, the model-family select (+ companion "Custom"
 * text input) is shown instead — used for switching an agent's model, same
 * select/custom-input pair as the New Agent modal's Model field (see
 * setModelSelectValue/getModelSelectValue). `textInput` and `modelInput` are
 * mutually exclusive; passing both is undefined behavior.
 * `okLabel` overrides the confirm button's text (defaults to the "Delete"
 * label baked into its markup, right for every other current caller).
 * @param {string} message
 * `textInput.list` names a `<datalist>` of suggestions for the field.
 * `modelInput.provider` is the agent's provider id, which decides which
 * model aliases are offered, or for a provider with none, which models are
 * listed (in `modelInput.workingDir`, see fetchProviderModels).
 * @param {{ checkboxLabel?: string, textInput?: { value?: string, placeholder?: string, list?: string }, modelInput?: { value?: string, provider?: string, workingDir?: string }, okLabel?: string }} [opts]
 * @returns {Promise<{ confirmed: boolean, checked: boolean, value: string }>}
 */
/** Bumped per confirmDialog() call, so a late model list never lands in a later dialog. */
let confirmDialogSeq = 0;

function confirmDialog(message, opts = {}) {
  confirmMessage.textContent = message;
  confirmCheckboxRow.hidden = !opts.checkboxLabel;
  if (opts.checkboxLabel) {
    confirmCheckboxLabel.textContent = opts.checkboxLabel;
    confirmCheckbox.checked = false;
  }
  confirmTextRow.hidden = !opts.textInput;
  if (opts.textInput) {
    confirmTextInput.value = opts.textInput.value ?? '';
    confirmTextInput.placeholder = opts.textInput.placeholder ?? '';
    if (opts.textInput.list) confirmTextInput.setAttribute('list', opts.textInput.list);
    else confirmTextInput.removeAttribute('list');
  }
  confirmModelRow.hidden = !opts.modelInput;
  const confirmSeq = ++confirmDialogSeq;
  if (opts.modelInput) {
    const { value = '', provider, workingDir } = opts.modelInput;
    const display = providerDisplayFor(provider);
    setModelSelectValue(confirmModelSelect, confirmModelCustomInput, value, display);
    fetchProviderModels(display.id, workingDir).then((models) => {
      if (confirmSeq !== confirmDialogSeq || confirmOverlay.hidden || !models.length) return;
      // Keep whatever's been typed or picked since the dialog opened.
      const current = getModelSelectValue(confirmModelSelect, confirmModelCustomInput);
      const hadFocus = confirmModelRow.contains(document.activeElement);
      setModelSelectValue(confirmModelSelect, confirmModelCustomInput, current, display, models);
      if (hadFocus) (confirmModelSelect.hidden ? confirmModelCustomInput : confirmModelSelect).focus();
    });
  }
  confirmOk.textContent = opts.okLabel ?? t('confirm.deleteBtn');
  confirmOk.classList.toggle('neutral', Boolean(opts.textInput || opts.modelInput));
  confirmOverlay.hidden = false;
  if (opts.textInput) {
    confirmTextInput.focus();
    confirmTextInput.select();
  } else if (opts.modelInput) {
    (confirmModelSelect.hidden ? confirmModelCustomInput : confirmModelSelect).focus();
  }
  return new Promise((resolve) => { pendingConfirmResolve = resolve; });
}

/**
 * Resolves the in-flight confirmDialog() promise and hides the modal.
 * @param {boolean} confirmed
 */
function resolveConfirm(confirmed) {
  confirmOverlay.hidden = true;
  const value = confirmModelRow.hidden
    ? confirmTextInput.value
    : getModelSelectValue(confirmModelSelect, confirmModelCustomInput);
  pendingConfirmResolve?.({
    confirmed,
    checked: !confirmCheckboxRow.hidden && confirmCheckbox.checked,
    value,
  });
  pendingConfirmResolve = null;
}

confirmCancel.addEventListener('click', () => resolveConfirm(false));
confirmOk.addEventListener('click', () => resolveConfirm(true));
confirmTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(true); }
});
confirmModelSelect.addEventListener('change', () => {
  confirmModelCustomInput.hidden = confirmModelSelect.value !== 'custom';
  if (confirmModelSelect.value === 'custom') {
    confirmModelCustomInput.focus();
    confirmModelCustomInput.select();
  }
});
confirmModelCustomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(true); }
});

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connectWs() {
  const url = `ws://${location.host}/ws`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    connDot.classList.add('connected');
    connDot.title = t('conn.connected');
    reconnNotice.hidden = true;
    msgInput.disabled = false;
    sendBtn.disabled = false;
    micBtn.disabled = false;
    wsBackoff = 1000;
  };

  ws.onmessage = (ev) => {
    try {
      handleServerEvent(JSON.parse(ev.data));
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    connDot.classList.remove('connected');
    connDot.title = t('conn.disconnected');
    reconnNotice.hidden = false;
    msgInput.disabled = true;
    sendBtn.disabled = true;
    micBtn.disabled = true;
    if (isDictating) recognition.stop();
    ws = null;
    setTimeout(() => {
      wsBackoff = Math.min(wsBackoff * 2, MAX_BACKOFF);
      connectWs();
    }, wsBackoff);
  };

  ws.onerror = () => ws.close();
}

/**
 * Sends a USER_MESSAGE over the WebSocket.
 * @param {string} chatId
 * @param {string} content
 * @param {Attachment[]} [attachments]
 */
function sendMessage(chatId, content, attachments = []) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'USER_MESSAGE', chatId, content, attachments }));
  }
}

// ─── Server event handler ────────────────────────────────────────────────────

/**
 * Dispatches a parsed server WebSocket event to the appropriate handler.
 * @param {{ type: string, [key: string]: unknown }} event
 */
function handleServerEvent(event) {
  switch (event.type) {
    case 'MESSAGE_SAVED':
      onMessageSaved(/** @type {Message} */ (event.message));
      break;
    case 'AGENT_STREAM_START':
      onStreamStart(event);
      break;
    case 'AGENT_STREAM_SNAPSHOT':
      onStreamSnapshot(event);
      break;
    case 'AGENT_STREAM_CHUNK':
      onStreamChunk(event);
      break;
    case 'AGENT_STREAM_STATUS':
      onStreamStatus(event);
      break;
    case 'AGENT_STREAM_END':
      onStreamEnd(event);
      break;
    case 'AGENT_STREAM_ERROR':
      onStreamError(event);
      break;
    case 'AGENT_STREAM_DISCARD':
      onStreamDiscard(event);
      break;
    case 'AGENT_BACKGROUND_MESSAGE':
      onAgentBackgroundMessage(event);
      break;
    case 'AGENT_BACKGROUND_TASKS':
      onAgentBackgroundTasks(event);
      break;
    case 'AGENT_UPDATED':
      onAgentUpdated(/** @type {Agent} */ (event.agent));
      break;
    case 'AGENT_CREATED':
      onAgentCreated(/** @type {Agent} */ (event.agent));
      break;
    case 'AGENT_DELETED':
      onAgentDeleted(/** @type {{ agentId: string }} */ (event));
      break;
    case 'CHAT_CREATED':
      onChatCreated(/** @type {Chat} */ (event.chat));
      break;
    case 'CHAT_UPDATED':
      onChatUpdated(/** @type {Chat} */ (event.chat));
      break;
    case 'CHAT_DELETED':
      onChatDeleted(/** @type {{ chatId: string }} */ (event));
      break;
    case 'SCHEDULED_MESSAGE_FIRED':
      onScheduledMessageFired(/** @type {{ chatId: string, id: string }} */ (event));
      break;
  }
}

/**
 * A scheduled message just fired — the message itself arrives separately
 * via the normal MESSAGE_SAVED/AGENT_STREAM_* events, so this only needs to
 * drop it from the locally-tracked pending list and re-render the panel.
 * @param {{ chatId: string, id: string }} event
 */
function onScheduledMessageFired({ chatId, id }) {
  if (chatId !== activeChatId) return;
  pendingScheduledMessages = pendingScheduledMessages.filter((m) => m.id !== id);
  renderScheduledPanel();
}

/**
 * @param {Message} message
 */
function onMessageSaved(message) {
  if (message.chatId !== activeChatId) return;
  // A page other than the latest is a frozen snapshot the user is reading
  // further back in — see loadMessagesPage/isViewingLatestPage's docs.
  if (!isViewingSearchContext && !isViewingLatestPage()) return;
  appendMessage(message);
}

/**
 * @param {{ streamId: string, chatId: string, agentId: string, agentName: string, agentColor: string }} event
 */
function onStreamStart({ streamId, chatId, agentId, agentName, agentColor }) {
  const entry = {
    streamId,
    chatId,
    agentId,
    agentName,
    agentColor,
    startedAt: Date.now(),
    rawText: '',
    statusText: '',
    typingHidden: false,
  };
  streamingEntries[streamId] = entry;
  // See onMessageSaved's matching guard — an older page is a frozen
  // snapshot; the bubble stays un-rendered (entry itself is still tracked)
  // until the user pages back to the end.
  if (chatId === activeChatId && (isViewingSearchContext || isViewingLatestPage())) attachStreamingBubble(entry);
  syncStreamingIndicators();
}

/**
 * A turn that was already in flight when this client connected — see
 * ws/handler.js's buildActiveStreamSnapshot. Sent once per stream, right
 * after the socket opens, so a page refresh (or first load) mid-turn
 * reconstructs the same bubble a client that stayed connected would have,
 * instead of showing nothing until the turn finishes.
 *
 * Skipped if this streamId is already tracked — a brief reconnect (not a
 * full page reload) keeps the existing JS state, which is already correct
 * and live; re-seeding it from the snapshot would just clobber it with a
 * (by now stale) one-time copy.
 * @param {{ streamId: string, chatId: string, agentId: string, agentName: string,
 *           agentColor: string, startedAt: number, text: string, statusText: string }} event
 */
function onStreamSnapshot({ streamId, chatId, agentId, agentName, agentColor, startedAt, text, statusText }) {
  if (streamingEntries[streamId]) return;
  const entry = {
    streamId,
    chatId,
    agentId,
    agentName,
    agentColor,
    startedAt,
    rawText: text,
    statusText,
    // A status already fired this turn (a tool ran, or is running) iff
    // statusText is non-empty — mirrors onStreamStatus's own un-hide logic,
    // so e.g. a subagent delegation that was mid-flight when this client
    // connected still shows as "Delegating: …" instead of silently reverting
    // to a bare "responding…" the moment real text does arrive.
    typingHidden: text.length > 0 && !statusText,
  };
  streamingEntries[streamId] = entry;
  if (chatId === activeChatId && (isViewingSearchContext || isViewingLatestPage())) attachStreamingBubble(entry);
  syncStreamingIndicators();
}

/**
 * Builds and appends the DOM bubble for a streaming entry that doesn't
 * currently have one, and wires up its live elapsed-time ticker/stop
 * button. Used both for a stream that starts while its chat is already
 * active (onStreamStart) and for one still running in a chat the user
 * switches back into (selectChat's reconciliation pass) — in the latter
 * case the entry's data fields (rawText/statusText/typingHidden/startedAt)
 * already reflect everything that happened while the chat was inactive, so
 * the rebuilt bubble picks up exactly where the live one would have been.
 * @param {StreamingEntry} entry
 */
function attachStreamingBubble(entry) {
  const el = createStreamingBubble(entry.agentId, entry.agentName, entry.agentColor);
  messageList.appendChild(el);
  scrollToBottom();

  entry.el = el;
  entry.body = el.querySelector('.msg-content');
  entry.typingEl = el.querySelector('.msg-typing');
  entry.statusTextEl = el.querySelector('.msg-status-text');
  entry.elapsedEl = el.querySelector('.msg-elapsed');

  entry.body.innerHTML = renderMarkdown(entry.rawText);
  decorateCodeBlocks(entry.body);
  entry.statusTextEl.textContent = entry.statusText || t('chat.respondingLabel');
  entry.typingEl.hidden = entry.typingHidden;
  if (!entry.typingHidden) {
    entry.elapsedEl.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - entry.startedAt) / 1000) });
    entry.timerId = setInterval(() => {
      entry.elapsedEl.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - entry.startedAt) / 1000) });
    }, 1000);
  }

  const stopBtn = el.querySelector('.msg-stop-btn');
  stopBtn.addEventListener('click', () => {
    stopAgentStream(entry.streamId);
    stopBtn.disabled = true;
    stopBtn.textContent = t('chat.stoppingLabel');
  });
}

/**
 * Tears down a streaming entry's DOM wiring (and stops its elapsed-time
 * interval) without discarding the entry itself — called when leaving a
 * chat, right before selectChat wipes messageList, so that reset doesn't
 * silently orphan a still-running interval pointing at now-detached
 * elements. The data fields survive untouched, so attachStreamingBubble can
 * rebuild an equivalent bubble later if the user switches back before the
 * stream ends.
 * @param {StreamingEntry} entry
 */
function detachStreamingBubble(entry) {
  if (entry.timerId) clearInterval(entry.timerId);
  entry.el = undefined;
  entry.body = undefined;
  entry.typingEl = undefined;
  entry.statusTextEl = undefined;
  entry.elapsedEl = undefined;
  entry.timerId = undefined;
}

/**
 * Stops an entry's elapsed-time ticker and hides its "responding…"/status
 * row — called whenever real text starts (or resumes) flowing, so the live
 * status doesn't sit stale next to content that's already answering the
 * question. Not a one-way transition: a tool call (e.g. a Bash command or a
 * subagent delegation) occurring mid-reply pauses text and should bring this
 * row right back — see showStreamStatus, which this pairs with.
 * @param {{ timerId: number | undefined, typingEl: HTMLElement }} entry
 */
function stopStreamStatus(entry) {
  clearInterval(entry.timerId);
  entry.timerId = undefined;
  entry.typingEl.hidden = true;
}

/**
 * Re-shows the "what's happening now" row and restarts its elapsed-time
 * ticker — the counterpart to stopStreamStatus, called when a tool_use
 * status arrives after text had already hidden the row. Without this, any
 * tool call or subagent delegation that happens after an agent's first
 * sentence of commentary (the common case — "let me check X first…") was
 * invisible: the row stayed hidden for the rest of the turn and the bubble
 * looked idle until the next chunk of text appeared out of nowhere.
 * @param {StreamingEntry} entry
 */
function showStreamStatus(entry) {
  entry.typingEl.hidden = false;
  entry.elapsedEl.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - entry.startedAt) / 1000) });
  entry.timerId = setInterval(() => {
    entry.elapsedEl.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - entry.startedAt) / 1000) });
  }, 1000);
}

/**
 * @param {{ streamId: string, text: string }} event
 */
function onStreamChunk({ streamId, text }) {
  const entry = streamingEntries[streamId];
  if (!entry) return;
  if (text && !entry.typingHidden) {
    entry.typingHidden = true;
    if (entry.el) stopStreamStatus(entry);
    renderTypingBar();
  }
  entry.rawText += text;
  // Re-rendered from the full accumulated text each time, not patched
  // incrementally — a still-open token (half-typed "**bold", an unclosed
  // code fence) just renders as literal text until its closing token
  // arrives and it snaps into formatting. Cosmetic only, self-correcting.
  if (entry.body) {
    entry.body.innerHTML = renderMarkdown(entry.rawText);
    decorateCodeBlocks(entry.body);
    scrollToBottom();
  }
}

/**
 * Live "what's happening now" update, parsed server-side from the agent's
 * tool_use calls (e.g. "Reading file.js", "Delegating: …" for a subagent) —
 * replaces the static "responding…" placeholder so a long multi-step turn
 * doesn't look stalled. Previously this bailed out for good once any text
 * had streamed (entry.typingHidden), which meant a tool call or subagent
 * delegation happening AFTER the agent's first bit of commentary had no
 * visible effect at all — the bubble just looked frozen on stale text until
 * more text eventually appeared. Now a status always updates the label, and
 * re-shows the row if text had hidden it, since a status only ever fires
 * when the model has paused texting to actually do something.
 * @param {{ streamId: string, status: string }} event
 */
function onStreamStatus({ streamId, status }) {
  const entry = streamingEntries[streamId];
  if (!entry) return;
  entry.statusText = status;
  if (entry.statusTextEl) entry.statusTextEl.textContent = status;
  if (entry.typingHidden) {
    entry.typingHidden = false;
    if (entry.el) showStreamStatus(entry);
  }
  renderTypingBar();
}

/**
 * @param {{ streamId: string, message: Message, agentId: string,
 *           permissionDenials: import('../services/agentRunner.js').PermissionDenial[],
 *           stopped: boolean }} event
 */
function onStreamEnd({ streamId, chatId, message, agentId, permissionDenials, stopped }) {
  const entry = streamingEntries[streamId];
  if (entry) {
    if (entry.timerId) clearInterval(entry.timerId);
    delete streamingEntries[streamId];
  }
  syncStreamingIndicators();

  // An agent reply landing in a chat the user isn't currently looking at —
  // flag it unread. There's nothing to render here either way: any bubble
  // for this stream was already detached (if the user switched away —
  // see selectChat) or never existed (if this chat was never active during
  // the whole turn), and the message is safely persisted server-side, so
  // it'll show up via the normal REST load whenever the user switches in.
  if (chatId !== activeChatId) {
    unreadChatIds.add(chatId);
    renderChatList();
    return;
  }

  if ($(`[data-msg-id="${message.id}"]`)) return; // already rendered (e.g. a duplicate event)

  const finalEl = buildMessageEl(message);
  if (entry?.el) entry.el.replaceWith(finalEl);
  else messageList.appendChild(finalEl);

  // Purely a live-session annotation — not persisted, so it won't reappear
  // after a reload. That's fine: it's just telling the user "this is why
  // the reply cuts off here", not part of the durable record.
  if (stopped) {
    finalEl.querySelector('.msg-meta').insertAdjacentHTML(
      'beforeend',
      `<span class="msg-stopped-badge" data-testid="msg-stopped-badge" title="${t('chat.stoppedTitle')}">⏹ ${t('chat.stoppedLabel')}</span>`
    );
  }

  if (permissionDenials?.length) {
    const card = buildPermissionCard(agentId, chatId, permissionDenials);
    finalEl.after(card);
  }
  flagUnseenOutsideFocus(agentId);
  scrollToBottom();
}

/**
 * An agent's persistent process resumed and reported on its own — most
 * commonly a backgrounded Bash task finishing — without any new user
 * message to trigger it (see agentProcessManager.js's onBackgroundTurn on
 * the server for the mechanism). Its live progress streamed into a normal
 * streaming bubble under `streamId`, which is dropped here in favor of the
 * persisted message.
 * @param {{ chatId: string, agentId: string, message: Message, streamId?: string | null,
 *           permissionDenials: import('../services/agentRunner.js').PermissionDenial[] }} event
 */
function onAgentBackgroundMessage({ chatId, agentId, message, permissionDenials, streamId }) {
  // The live bubble this turn streamed into while it ran (if any) — replaced
  // by the persisted message appended below.
  if (streamId) onStreamDiscard({ streamId });
  if (chatId !== activeChatId) {
    unreadChatIds.add(chatId);
    renderChatList();
    return;
  }
  appendMessage(message);
  if (permissionDenials?.length) {
    const card = buildPermissionCard(agentId, chatId, permissionDenials);
    $(`[data-msg-id="${message.id}"]`)?.after(card);
  }
  flagUnseenOutsideFocus(agentId);
  scrollToBottom();
}

/**
 * A live stream for a turn the agent started on its own ended with nothing
 * to replace it — drop the bubble (see ws/handler.js's AgentStreamDiscardEvent).
 * @param {{ streamId: string }} event
 */
function onStreamDiscard({ streamId }) {
  const entry = streamingEntries[streamId];
  if (!entry) return;
  if (entry.timerId) clearInterval(entry.timerId);
  entry.el?.remove();
  delete streamingEntries[streamId];
  syncStreamingIndicators();
}

/**
 * Timer ticking the typing bar's elapsed-time labels — runs only while the
 * bar has something to show (see renderTypingBar).
 * @type {ReturnType<typeof setInterval> | undefined}
 */
let typingBarTimerId;

/**
 * Re-syncs every "who's still working" signal after a stream starts or
 * stops: the typing bar above the composer, the busy marker on each agent
 * in the agent panel, and the one on each chat in the chat list. The last
 * two toggle a class on rows already rendered instead of re-rendering the
 * list, so an open agent ⋮ menu or a chat being renamed isn't torn down
 * every time some agent starts or finishes a turn.
 */
function syncStreamingIndicators() {
  renderTypingBar();
  const entries = Object.values(streamingEntries);
  const streamingAgentIds = new Set(entries.map((e) => e.agentId));
  const busyChatIds = new Set(entries.map((e) => e.chatId));
  for (const li of agentList.querySelectorAll('.agent-item')) {
    li.classList.toggle('is-streaming', streamingAgentIds.has(li.dataset.agentId));
  }
  for (const li of chatList.querySelectorAll('.chat-item')) {
    li.classList.toggle('is-busy', busyChatIds.has(li.dataset.chatId));
  }
}

/**
 * Whether any turn is in flight in `chatId` — for the chat list's busy
 * marker at render time (syncStreamingIndicators keeps it current after).
 * @param {string} chatId
 * @returns {boolean}
 */
function isChatBusy(chatId) {
  return Object.values(streamingEntries).some((e) => e.chatId === chatId);
}

/**
 * Whether `agentId` has a turn in flight — the agent panel's counterpart
 * to isChatBusy.
 * @param {string} agentId
 * @returns {boolean}
 */
function isAgentStreaming(agentId) {
  return Object.values(streamingEntries).some((e) => e.agentId === agentId);
}

/**
 * The strip above the composer naming every agent still working in the
 * active chat, with what it's doing right now and for how long — the
 * "X is typing…" of a group chat. Each streaming bubble already says this,
 * but with several agents replying at once (and finished replies landing in
 * between) those bubbles end up scattered up the scrollback, where the user
 * can't tell at a glance who's still going. A chip jumps to its bubble.
 */
function renderTypingBar() {
  clearInterval(typingBarTimerId);
  typingBarTimerId = undefined;
  const entries = Object.values(streamingEntries).filter((e) => e.chatId === activeChatId);
  typingBar.hidden = entries.length === 0;
  typingBar.innerHTML = '';
  if (!entries.length) return;

  for (const entry of entries) {
    const color = agentDisplayColor(entry.agentColor);
    // Text flowing hides the bubble's status row, so the chip says so
    // instead of repeating a status the agent has moved past.
    const status = entry.typingHidden ? t('chat.typingWritingLabel') : (entry.statusText || t('chat.respondingLabel'));
    const chip = document.createElement('button');
    chip.className = 'typing-chip';
    chip.dataset.testid = 'typing-chip';
    chip.dataset.agentId = entry.agentId;
    chip.style.setProperty('--author-color', color);
    chip.title = t('chat.typingChipTitle', { name: entry.agentName, status });
    chip.innerHTML = `
      <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="typing-chip-name">${escHtml(entry.agentName)}</span>
      <span class="typing-chip-status" data-testid="typing-chip-status">${escHtml(status)}</span>
      <span class="typing-chip-elapsed" data-started-at="${entry.startedAt}"></span>`;
    chip.addEventListener('click', () => {
      if (!entry.el || entry.el.hidden) return;
      entry.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      entry.el.classList.remove('highlight-flash');
      void entry.el.offsetWidth; // restart the animation on a repeat click
      entry.el.classList.add('highlight-flash');
    });
    typingBar.appendChild(chip);
  }

  const tick = () => {
    for (const el of typingBar.querySelectorAll('.typing-chip-elapsed')) {
      el.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - Number(el.dataset.startedAt)) / 1000) });
    }
  };
  tick();
  typingBarTimerId = setInterval(tick, 1000);
}

/**
 * @param {{ agentId: string, tasks: { id: string, type: string, description: string }[] }} event
 */
function onAgentBackgroundTasks({ agentId, tasks }) {
  if (tasks.length) backgroundTasksByAgentId.set(agentId, tasks);
  else backgroundTasksByAgentId.delete(agentId);
  renderAgentPanel();
}

/**
 * Agent-panel badge for an agent's still-running background tasks, or ''
 * if it has none — see backgroundTasksByAgentId.
 * @param {Agent} agent
 * @returns {string}
 */
function renderBackgroundTasksBadge(agent) {
  const tasks = backgroundTasksByAgentId.get(agent.id);
  if (!tasks?.length) return '';
  const label = tasks.length === 1
    ? t('agent.backgroundTasksBadgeOne', { description: tasks[0].description })
    : t('agent.backgroundTasksBadgeMany', { count: tasks.length });
  const title = t('agent.backgroundTasksBadgeTitle', { list: tasks.map((task) => `• ${task.description}`).join('\n') });
  return `<span class="agent-bg-tasks" data-testid="agent-bg-tasks" title="${escHtml(title)}">⚙️ ${escHtml(label)}</span>`;
}

/**
 * Sends a STOP_AGENT event asking the server to kill the in-flight `claude`
 * process for this stream (SIGTERM) and resolve with whatever partial
 * response it had produced so far, instead of waiting for it to finish
 * on its own — mirrors interrupting a running command in a real terminal.
 * @param {string} streamId
 */
function stopAgentStream(streamId) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'STOP_AGENT', streamId }));
  }
}

/**
 * Handles a server-sent AGENT_UPDATED event — keeps local agent state in sync
 * after a GRANT_PERMISSION is processed.
 * @param {Agent} updatedAgent
 */
function onAgentUpdated(updatedAgent) {
  const idx = agents.findIndex((a) => a.id === updatedAgent.id);
  if (idx !== -1) agents[idx] = updatedAgent;
  renderAgentPanel();
  if (grantsAgentId === updatedAgent.id) renderGrantsModal();
}

/**
 * Handles a server-sent AGENT_CREATED event — an agent created outside this
 * tab (e.g. via an MCP tool call) wasn't in local state yet, unlike
 * AGENT_UPDATED which only ever patches an existing entry. Guarded against
 * double-adding an echo of a creation this same tab already made via REST.
 * @param {Agent} agent
 */
function onAgentCreated(agent) {
  if (agents.some((a) => a.id === agent.id)) return;
  agents.push(agent);
  renderAgentPanel();
}

/**
 * Handles a server-sent AGENT_DELETED event — an agent deleted outside this
 * tab. Harmless no-op if this tab already removed it locally.
 * @param {{ agentId: string }} event
 */
function onAgentDeleted({ agentId }) {
  agents = agents.filter((a) => a.id !== agentId);
  renderAgentPanel();
}

/**
 * Handles a server-sent CHAT_CREATED event, same reasoning as
 * onAgentCreated above.
 * @param {Chat} chat
 */
function onChatCreated(chat) {
  if (chats.some((c) => c.id === chat.id)) return;
  chats.push(chat);
  renderChatList();
}

/**
 * Handles a server-sent CHAT_UPDATED event (rename, freeRelay/autoContinue/
 * category change, or a membership change) — same fetch-then-patch-local-
 * state update the REST-driven call sites (toggleFreeRelay, addMember, ...)
 * already do for this tab's own edits, just triggered by someone else's.
 * @param {Chat} chat
 */
function onChatUpdated(chat) {
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx !== -1) chats[idx] = chat; else chats.push(chat);
  if (chat.id === activeChatId) {
    chatTopbarName.textContent = t('chat.channelName', { name: chat.name });
    renderFreeRelayBtn();
    renderAutoContinueBtn();
  }
  renderChatList();
  renderAgentPanel();
}

/**
 * Handles a server-sent CHAT_DELETED event — mirrors deleteChat's own local
 * cleanup for this tab's own deletes.
 * @param {{ chatId: string }} event
 */
function onChatDeleted({ chatId }) {
  chats = chats.filter((c) => c.id !== chatId);
  unreadChatIds.delete(chatId);
  if (activeChatId === chatId) showEmptyChatState();
  renderChatList();
}

/**
 * Opens an agent's working directory in the OS's native file manager.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function openAgentFolder(agent) {
  await fetch(`/api/agents/${agent.id}/open-folder`, { method: 'POST' });
}

/**
 * Kills and respawns an agent's persistent CLI process (no data lost — the
 * next turn `--resume`s). Useful for picking up state a running process
 * only ever reads once at spawn time and never refreshes on its own, like a
 * newly-authorized MCP connector.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function restartAgent(agent) {
  await fetch(`/api/agents/${agent.id}/restart`, { method: 'POST' });
}

/**
 * Copies a ready-to-paste `claude --resume <id>` command to the clipboard so
 * the user can continue an agent's native Claude session in their terminal.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function copySessionCommand(agent) {
  if (!agent.resumeId) return;
  await navigator.clipboard.writeText(providerDisplayFor(agent.provider).resumeCommand(agent.resumeId));
  const btn = document.querySelector(`[data-agent-id="${agent.id}"] .agent-session-btn`);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = t('agent.copiedFeedback');
  setTimeout(() => { btn.textContent = original; }, 1200);
}

/**
 * Builds a permission-denial card that lets the user grant access.
 * @param {string} agentId
 * @param {string} chatId
 * @param {import('../services/agentRunner.js').PermissionDenial[]} denials
 * @returns {HTMLElement}
 */
function buildPermissionCard(agentId, chatId, denials) {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.dataset.testid = 'perm-card';
  card.dataset.agentId = agentId ?? '';
  card.hidden = !isVisibleUnderMessageFilter(agentId);

  const header = document.createElement('div');
  header.className = 'perm-header';
  card.appendChild(header);

  const label = document.createElement('p');
  label.className = 'perm-label';
  label.textContent = t('perm.requiredLabel');
  header.appendChild(label);

  // A single turn can carry more than one denial for the exact same
  // tool+command — the model sometimes retries a blocked call itself before
  // giving up and reporting back. Without deduping, that renders two
  // identical rows and the user has to click "Grant" twice for one actual
  // authorization. Keep only the first occurrence of each tool+value pair.
  // Deduped up front (not inline in the render loop below) so the total row
  // count is known before any row is built — needed for the
  // resolve-one-at-a-time tracking right after.
  const seen = new Set();
  const uniqueDenials = [];
  for (const denial of denials) {
    // Display value: a real path for file-scoped tools, the literal command
    // for Bash, a raw JSON dump as a last resort for anything else — this is
    // just what's SHOWN. The value actually sent to grant is the same string;
    // the server (not the client) decides how to turn it into an
    // authorization, since only it knows the CLI's permission-pattern syntax.
    const value = denial.tool_input?.file_path ?? denial.tool_input?.command ?? JSON.stringify(denial.tool_input);
    const key = `${denial.tool_name}::${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueDenials.push({ denial, value });
  }

  // If a turn produced more than one distinct denial, resolving just one of
  // them shouldn't immediately nudge the agent to retry while its siblings
  // in the same card are still pending — that races an auto-continued turn
  // against the user still working through the rest of the card. Only the
  // click that resolves the LAST still-pending row in THIS card tells the
  // server to auto-continue; earlier ones in the same card just persist
  // (grant) or no-op (deny) without triggering anything yet. `outcomes` is
  // indexed to match display order (not click order) and sent in full only
  // on that final click, since the server has no other memory of a denial
  // (nothing is persisted for a deny) — it's the only record of what
  // happened to every row in the card, used to build one combined
  // continuation message covering all of them.
  const totalRows = uniqueDenials.length;
  let resolvedCount = 0;
  /** @type {({ toolName: string, value: string, granted: boolean } | null)[]} */
  const outcomes = new Array(totalRows).fill(null);

  // Bulk grant, for when a turn racked up several denials at once (e.g. a
  // multi-file edit, or a few different Bash calls) and clicking "Grant"
  // one row at a time is just tedium — only worth showing when there's
  // more than one row to resolve. Reuses the exact same resolveRow path as
  // an individual row's own button, so a mix of some rows already resolved
  // by hand and the rest resolved in bulk still ends up with exactly one
  // autoContinue firing, on whichever click resolves the last row.
  let grantAllBtn = null;
  if (totalRows > 1) {
    grantAllBtn = document.createElement('button');
    grantAllBtn.className = 'perm-grant-all-btn';
    grantAllBtn.dataset.testid = 'perm-grant-all-btn';
    grantAllBtn.textContent = t('perm.grantAllBtn');
    grantAllBtn.addEventListener('click', () => {
      grantAllBtn.disabled = true;
      for (const state of rowStates) {
        if (!state.resolved) resolveRow(state, true);
      }
    });
    header.appendChild(grantAllBtn);
  }

  /**
   * Resolves one row (grant or deny), shared by that row's own button and
   * the bulk "Grant all" button above. A row can only be resolved one way —
   * marking it `resolved` and disabling both its buttons rules out
   * grant-then-deny (or vice versa) on the same denial, whichever path
   * triggered it.
   * @param {{ idx: number, denial: import('../services/agentRunner.js').PermissionDenial, value: string, grantBtn: HTMLButtonElement, denyBtn: HTMLButtonElement, resolved: boolean }} state
   * @param {boolean} granted
   */
  function resolveRow(state, granted) {
    state.resolved = true;
    resolvedCount += 1;
    outcomes[state.idx] = { toolName: state.denial.tool_name, value: state.value, granted };
    const autoContinue = resolvedCount === totalRows;
    if (granted) {
      grantPermission(agentId, chatId, state.denial.tool_name, state.value, autoContinue, autoContinue ? outcomes : undefined);
      state.grantBtn.textContent = t('perm.grantedBtn');
    } else {
      denyPermission(agentId, chatId, state.denial.tool_name, state.value, autoContinue, autoContinue ? outcomes : undefined);
      state.denyBtn.textContent = t('perm.deniedBtn');
    }
    state.grantBtn.disabled = true;
    state.denyBtn.disabled = true;
    if (grantAllBtn && resolvedCount === totalRows) grantAllBtn.hidden = true;
  }

  /** @type {{ idx: number, denial: import('../services/agentRunner.js').PermissionDenial, value: string, grantBtn: HTMLButtonElement, denyBtn: HTMLButtonElement, resolved: boolean }[]} */
  const rowStates = [];

  uniqueDenials.forEach(({ denial, value }, idx) => {
    const row = document.createElement('div');
    row.className = 'perm-row';
    row.innerHTML = `
      <span class="perm-tool">${escHtml(denial.tool_name)}</span>
      <span class="perm-path" title="${escHtml(String(value))}">${escHtml(String(value))}</span>
      <button class="perm-deny-btn" data-testid="perm-deny-btn">${t('perm.denyBtn')}</button>
      <button class="perm-grant-btn" data-testid="perm-grant-btn">${t('perm.grantBtn')}</button>`;
    const grantBtn = row.querySelector('.perm-grant-btn');
    const denyBtn = row.querySelector('.perm-deny-btn');
    const state = { idx, denial, value, grantBtn, denyBtn, resolved: false };
    rowStates.push(state);
    grantBtn.addEventListener('click', () => resolveRow(state, true));
    denyBtn.addEventListener('click', () => resolveRow(state, false));
    card.appendChild(row);
    const saves = grantPreviewText(denial.grant);
    if (saves) {
      const savesLine = document.createElement('div');
      savesLine.className = 'perm-saves';
      savesLine.dataset.testid = 'perm-saves';
      savesLine.textContent = saves;
      card.appendChild(savesLine);
    }
  });

  return card;
}

/**
 * What Grant on a permission row will save, as the server previewed it
 * (withGrantPreviews in agentRunner.js): a grant lasts until revoked, so
 * the card says how far it reaches before the click, not after.
 * @param {{ path?: string, patterns?: string[] } | undefined} grant
 * @returns {string}
 */
function grantPreviewText(grant) {
  if (grant?.path) return t('perm.savesFolder', { path: grant.path });
  if (grant?.patterns?.length) return t('perm.savesRules', { rules: grant.patterns.join(', ') });
  return '';
}

/**
 * Sends a GRANT_PERMISSION event to the server for the given agent, tool,
 * and denial value (a file path for file-scoped tools, a raw command
 * string for Bash, etc.) — the server derives the actual authorization
 * mechanism (--add-dir vs. a --allowedTools pattern) from toolName. Only
 * auto-continues the agent's turn when `autoContinue` is true — pass false
 * while sibling denials in the same card are still unresolved, so the
 * agent isn't nudged to retry mid-way through the user working through the
 * rest of the card (see buildPermissionCard's resolvedCount tracking).
 * @param {string} agentId
 * @param {string} chatId
 * @param {string} toolName
 * @param {string} value
 * @param {boolean} autoContinue
 * @param {{ toolName: string, value: string, granted: boolean }[]} [outcomes] -
 *   Every row's resolution in this card, in display order. Only meaningful
 *   (and only ever passed) when autoContinue is true — the server uses it
 *   to build one continuation message covering every outcome, since it has
 *   no other record of a denied row (nothing is persisted for a deny).
 */
function grantPermission(agentId, chatId, toolName, value, autoContinue, outcomes) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GRANT_PERMISSION', agentId, chatId, toolName, value, autoContinue, outcomes }));
  }
}

/**
 * Sends a DENY_PERMISSION event to the server for the given agent, tool,
 * and denial value — unlike grantPermission, nothing gets persisted (a
 * denial is already the default). Same `autoContinue`/`outcomes` gating as
 * grantPermission: only re-prompts the agent once this was the last
 * pending denial in its card.
 * @param {string} agentId
 * @param {string} chatId
 * @param {string} toolName
 * @param {string} value
 * @param {boolean} autoContinue
 * @param {{ toolName: string, value: string, granted: boolean }[]} [outcomes]
 */
function denyPermission(agentId, chatId, toolName, value, autoContinue, outcomes) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'DENY_PERMISSION', agentId, chatId, toolName, value, autoContinue, outcomes }));
  }
}

/**
 * @param {{ streamId: string, error: string }} event
 */
function onStreamError({ streamId, error }) {
  const entry = streamingEntries[streamId];
  if (!entry) return;
  delete streamingEntries[streamId];
  syncStreamingIndicators();
  if (!entry.el) return; // errored while its chat wasn't active — not persisted server-side, so nothing to show later either
  stopStreamStatus(entry);
  entry.body.textContent = t('errors.streamErrorPrefix', { error });
  entry.body.style.color = 'var(--red)';
  entry.el.classList.remove('streaming');
  // The turn is already over, so a Stop click would wait forever on a
  // stream the server no longer has.
  entry.el.querySelector('.msg-stop-btn')?.remove();
}

// ─── DOM rendering ───────────────────────────────────────────────────────────

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Client-side mirror of server/services/messageRouter.js's
 * extractMentionedAgents — matches against the actual roster's names
 * (longest first) rather than a fixed `\w+` character class, so a mention
 * counts wherever it sits in the text, matching how the server actually
 * routes it. Kept as a separate small copy rather than sharing a module: the
 * server's version returns Agent objects from its own DB-backed lookup,
 * this one just needs the subset of matching ids for filter comparisons.
 *
 * Regression note: this used to be a plain `/@(\w+)/g` scan, same as the
 * server had — which silently failed on any hyphenated agent name (`\w`
 * doesn't include `-`), so "@TP-Alice do X" resolved to zero mentioned ids
 * here and was then treated as a broadcast (isVisibleUnderMessageFilter's
 * "empty = broadcast" rule) — visible under EVERY spotlight filter,
 * including one spotlighting a completely different, unmentioned agent.
 * @param {string} content
 * @param {Agent[]} members
 * @returns {string[]}
 */
function extractMentionedAgentIds(content, members) {
  const names = members
    .map((a) => a.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return [];
  const mentionRegex = new RegExp(`@(${names.join('|')})(?![\\w-])`, 'gi');
  const mentioned = new Set([...content.matchAll(mentionRegex)].map((m) => m[1].toLowerCase()));
  return members.filter((a) => mentioned.has(a.name.toLowerCase())).map((a) => a.id);
}

/**
 * Whether something authored by `agentId` (null for the user's own
 * messages) should be visible under the current message filter. See
 * messageFilterAgentIds's own docs for what "the filter" means.
 *
 * `mentionedIds` only matters for the user's own messages (agentId null) —
 * it's how a message you sent to a DIFFERENT agent gets correctly hidden
 * instead of always tagging along just because you authored it. An agent's
 * own messages ignore it entirely; their visibility is purely "is this
 * agent spotlighted," same as always.
 * @param {string | null} agentId
 * @param {string[]} [mentionedIds] - Agent ids this message @mentions,
 *   pre-resolved at render time (see buildMessageEl). Empty = broadcast.
 * @returns {boolean}
 */
function isVisibleUnderMessageFilter(agentId, mentionedIds = []) {
  if (messageFilterAgentIds.size === 0) return true;
  if (agentId) return messageFilterAgentIds.has(agentId);
  return mentionedIds.length === 0 || mentionedIds.some((id) => messageFilterAgentIds.has(id));
}

/**
 * Re-evaluates every already-rendered message, streaming bubble, and
 * permission card against the current filter — called right after the
 * filter itself changes, since everything up to that point was rendered
 * under the OLD filter state and buildMessageEl/createStreamingBubble/
 * buildPermissionCard only decide visibility once, at creation time. Each
 * of those tags its root element with data-agent-id (empty string for the
 * user's own messages) specifically so this can re-derive the right answer
 * later without keeping a parallel registry in sync. data-mentioned-ids
 * (user messages only — see buildMessageEl) rides along the same way.
 * @returns {void}
 */
function applyMessageFilterToDom() {
  for (const el of messageList.querySelectorAll('[data-agent-id]')) {
    const mentionedIds = el.dataset.mentionedIds ? el.dataset.mentionedIds.split(',') : [];
    el.hidden = !isVisibleUnderMessageFilter(el.dataset.agentId || null, mentionedIds);
  }
}

/**
 * Re-applies agentDisplayColor to every already-rendered message and
 * streaming bubble's --author-color and avatar fill — same data-agent-id
 * scan as applyMessageFilterToDom, for the same reason: buildMessageEl and
 * createStreamingBubble only resolve the contrast-corrected color once, at
 * creation time, so a later theme switch (which moves the contrast target —
 * see agentDisplayColor) or a user color change needs this to bring
 * already-rendered elements back in line without a full re-render.
 * @returns {void}
 */
function refreshAgentDisplayColors() {
  for (const el of messageList.querySelectorAll('[data-agent-id]')) {
    const agentId = el.dataset.agentId || null;
    const rawColor = agentId ? (agentById(agentId)?.color ?? 'var(--muted)') : userSettings.userColor;
    const color = agentDisplayColor(rawColor);
    el.style.setProperty('--author-color', color);
    const avatar = el.querySelector('.msg-avatar');
    if (avatar) avatar.style.background = color;
  }
}

/**
 * Toggles whether `agentId` is spotlighted by the message filter — added if
 * it wasn't in the set, removed if it was. Multiple agents can be
 * spotlighted at once (union, not single-select), so filtering to "Claudio
 * and Dana" is just clicking both of their panel buttons.
 * @param {string} agentId
 * @returns {void}
 */
function toggleMessageFilter(agentId) {
  if (messageFilterAgentIds.has(agentId)) {
    messageFilterAgentIds.delete(agentId);
  } else {
    messageFilterAgentIds.add(agentId);
    unseenOutsideFocusAgentIds.delete(agentId); // spotlighted — their messages are visible now
  }
  applyMessageFilterToDom();
  renderAgentPanel();
  renderMessageFilterBar();
}

/**
 * Clears the message filter entirely, back to showing everything.
 * @returns {void}
 */
function clearMessageFilter() {
  if (messageFilterAgentIds.size === 0) return;
  messageFilterAgentIds.clear();
  unseenOutsideFocusAgentIds.clear(); // everything's visible again
  applyMessageFilterToDom();
  renderAgentPanel();
  renderMessageFilterBar();
}

/**
 * Flags `agentId` as having an unseen message if the message filter is
 * currently spotlighting other agents — called for any agent message
 * landing in the chat the user is actively looking at (onStreamEnd,
 * onAgentBackgroundMessage), so a reply from outside the current focus
 * doesn't go unnoticed. No-op when there's no filter active or `agentId` is
 * itself spotlighted (its messages are already visible).
 * @param {string | null} agentId
 * @returns {void}
 */
function flagUnseenOutsideFocus(agentId) {
  if (!agentId || messageFilterAgentIds.size === 0 || messageFilterAgentIds.has(agentId)) return;
  unseenOutsideFocusAgentIds.add(agentId);
  renderAgentPanel();
}

/**
 * Shows (or hides, when the filter is empty) the banner above the message
 * list naming who's currently spotlighted, with a one-click way to clear it
 * — the filter toggle buttons live in the agent panel, easy to lose track
 * of once you've scrolled away from it, so this is the visible reminder
 * that the message list isn't currently showing everything.
 * @returns {void}
 */
function renderMessageFilterBar() {
  if (messageFilterAgentIds.size === 0) {
    messageFilterBar.hidden = true;
    messageFilterBar.innerHTML = '';
    updateChatHeaderExpandBtn();
    return;
  }
  const names = [...messageFilterAgentIds].map((id) => agentById(id)?.name).filter(Boolean).join(', ');
  messageFilterBar.hidden = false;
  messageFilterBar.innerHTML = `
    <span data-testid="message-filter-bar-label">${escHtml(t('chat.filterBarLabel', { names }))}</span>
    <button id="message-filter-clear-btn" data-testid="message-filter-clear-btn">${escHtml(t('chat.filterBarClearBtn'))}</button>`;
  messageFilterBar.querySelector('#message-filter-clear-btn').addEventListener('click', clearMessageFilter);
  updateChatHeaderExpandBtn();
}

// ─── Message search ─────────────────────────────────────────────────────────

/**
 * Shows the search bar and focuses its input. A no-op affordance when
 * there's no active chat — searching only ever makes sense scoped to one.
 * @returns {void}
 */
function openSearchBar() {
  if (!activeChatId) return;
  searchBtn.classList.add('active');
  searchBar.hidden = false;
  searchInput.focus();
  updateChatHeaderExpandBtn();
}

/**
 * Hides the search bar and clears any in-progress query/results, without
 * touching whatever message list state (normal or jumped-to-context) is
 * currently showing.
 * @returns {void}
 */
function closeSearchBar() {
  searchBtn.classList.remove('active');
  searchBar.hidden = true;
  searchResultsEl.hidden = true;
  searchResultsEl.innerHTML = '';
  searchInput.value = '';
  updateChatHeaderExpandBtn();
}

/**
 * Debounced handler for the search input — waits for a short pause in
 * typing before hitting the server, so fast typing doesn't fire a request
 * per keystroke.
 * @returns {void}
 */
function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runSearch(searchInput.value.trim()), 250);
}

/**
 * Searches the active chat's full message history (server-side — not just
 * whatever's currently rendered, since only a recent window is normally
 * loaded) and renders the results dropdown.
 * @param {string} query
 * @returns {Promise<void>}
 */
async function runSearch(query) {
  const requestId = ++searchRequestId;
  if (!query) {
    searchResultsEl.hidden = true;
    searchResultsEl.innerHTML = '';
    return;
  }
  const res = await fetch(`/api/chats/${activeChatId}/messages/search?q=${encodeURIComponent(query)}`);
  const results = /** @type {Message[]} */ (await res.json());
  if (requestId !== searchRequestId) return; // superseded by a newer keystroke

  renderSearchResults(results, query);
}

/**
 * Builds a plain-text snippet centred on the first match of `query` inside
 * `content`, with the match wrapped in <mark>. Every piece of real message
 * text is escaped individually before the <mark> tags are spliced in, so a
 * message containing HTML-looking text can't inject markup here.
 * @param {string} content
 * @param {string} query
 * @returns {string}
 */
function highlightSnippet(content, query) {
  const RADIUS = 60;
  const flat = content.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escHtml(flat.slice(0, RADIUS * 2));

  const start = Math.max(0, idx - RADIUS);
  const end = Math.min(flat.length, idx + query.length + RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  const before = escHtml(flat.slice(start, idx));
  const match = escHtml(flat.slice(idx, idx + query.length));
  const after = escHtml(flat.slice(idx + query.length, end));
  return `${prefix}${before}<mark>${match}</mark>${after}${suffix}`;
}

/**
 * Renders the search results dropdown, or a "no results" placeholder.
 * @param {Message[]} results
 * @param {string} query
 * @returns {void}
 */
function renderSearchResults(results, query) {
  if (results.length === 0) {
    searchResultsEl.innerHTML = `<li class="search-result-empty" data-testid="search-result-empty">${escHtml(t('search.noResults'))}</li>`;
    searchResultsEl.hidden = false;
    return;
  }
  searchResultsEl.innerHTML = '';
  for (const msg of results) {
    const agent = msg.agentId ? agentById(msg.agentId) : null;
    const color = agentDisplayColor(msg.role === 'user' ? userSettings.userColor : (agent?.color ?? 'var(--muted)'));
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.dataset.testid = 'search-result-item';
    li.style.setProperty('--author-color', color);
    li.innerHTML = `
      <div class="search-result-meta">
        <span class="search-result-author">${escHtml(msg.authorName)}</span>
        <span class="search-result-time">${fmtTime(msg.createdAt)}</span>
      </div>
      <div class="search-result-snippet">${highlightSnippet(msg.content, query)}</div>`;
    li.addEventListener('click', () => jumpToMessage(msg));
    searchResultsEl.appendChild(li);
  }
  searchResultsEl.hidden = false;
}

/**
 * Jumps the message list to a specific message, either found in the chat's
 * recently loaded window in place, or replacing the whole list with the
 * server-fetched window around it. Either way the target message is
 * scrolled into view and briefly flashed so it's easy to spot.
 * @param {Message} msg
 * @returns {Promise<void>}
 */
async function jumpToMessage(msg) {
  closeSearchBar();

  let el = messageList.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!el) {
    const res = await fetch(`/api/chats/${activeChatId}/messages/context/${msg.id}`);
    if (!res.ok) return;
    const contextMsgs = /** @type {Message[]} */ (await res.json());
    messageList.innerHTML = '';
    for (const m of contextMsgs) messageList.appendChild(buildMessageEl(m));
    isViewingSearchContext = true;
    jumpedBanner.hidden = false;
    pageNav.hidden = true;
    el = messageList.querySelector(`[data-msg-id="${msg.id}"]`);
  }
  if (!el) return;

  el.scrollIntoView({ block: 'center' });
  el.classList.remove('highlight-flash');
  // Force a reflow so re-adding the class restarts the animation even if
  // the same message was just jumped to a second time.
  void el.offsetWidth;
  el.classList.add('highlight-flash');
}

/**
 * Returns the message list to the normal paginated view after a search
 * jump, landing on the latest page.
 * @returns {Promise<void>}
 */
async function backToLatestMessages() {
  isViewingSearchContext = false;
  jumpedBanner.hidden = true;
  await loadMessagesPage(activeChatId, 'last');
}

/**
 * True exactly when the active chat's normal (non-search-context) message
 * view is showing its latest page — the only state in which live WS events
 * (onMessageSaved, onStreamStart) should render into the DOM. Viewing an
 * older page is deliberately a frozen snapshot: new activity doesn't
 * silently splice into a page the user is in the middle of reading further
 * back — see loadMessagesPage's docs.
 * @returns {boolean}
 */
function isViewingLatestPage() {
  return currentPage === totalPages;
}

/**
 * Reflects currentPage/totalPages onto #page-nav: hidden entirely for a
 * chat short enough to fit on one page (no clutter for the common case),
 * otherwise shown with First/Prev disabled on page 1 and Next/Last
 * disabled on the last page.
 */
function renderPageNav() {
  pageNav.hidden = totalPages <= 1;
  pageIndicator.textContent = t('chat.pageIndicator', { page: currentPage, totalPages });
  pageFirstBtn.disabled = currentPage === 1;
  pagePrevBtn.disabled = currentPage === 1;
  pageNextBtn.disabled = currentPage === totalPages;
  pageLastBtn.disabled = currentPage === totalPages;
  updateChatHeaderExpandBtn();
}

// ─── Collapsible panels ─────────────────────────────────────────────────────

/**
 * Parts of the layout that can be collapsed to give their space to the
 * messages, keyed by the `data-*` attribute set on <html> while collapsed
 * (style.css hides the part from that), with the localStorage key that
 * remembers it. The pre-paint script in index.html's <head> lists the same
 * pairs, so keep the two in step.
 *   - chatHeader: the bars above the message list — topbar, search bar,
 *     agent-filter bar, page navigation. Reported live: they took a lot of
 *     room, weren't needed most of the time, and crowded the messages out.
 *     Banners asking for action (jumped-to-context, stale auto-continue)
 *     stay visible.
 *   - sidebar, agentPanel: the chat list and the agent panel, on layouts
 *     wide enough to show them in place (narrower ones already make them
 *     drawers — see style.css).
 * @type {Record<'chatHeader' | 'sidebar' | 'agentPanel', string>}
 */
const COLLAPSIBLE_PARTS = {
  chatHeader: 'chatHeaderCollapsed',
  sidebar: 'sidebarCollapsed',
  agentPanel: 'agentPanelCollapsed',
};

/**
 * Collapses (or restores) one of COLLAPSIBLE_PARTS. Remembered per
 * browser, like the theme, and applied before first paint by index.html.
 * @param {keyof typeof COLLAPSIBLE_PARTS} part
 * @param {boolean} collapsed
 * @returns {void}
 */
function setCollapsed(part, collapsed) {
  if (collapsed) document.documentElement.dataset[part] = 'collapsed';
  else delete document.documentElement.dataset[part];
  try { localStorage.setItem(COLLAPSIBLE_PARTS[part], collapsed ? '1' : '0'); } catch { /* storage unavailable: still applies for this page */ }
}

/**
 * Marks the ▾ button that restores a collapsed header whenever one of the
 * hidden bars is showing something in effect — an open search, an agent
 * filter, or an older page — so collapsing never hides that the message
 * list isn't the plain, latest view.
 * @returns {void}
 */
function updateChatHeaderExpandBtn() {
  const hiddenState = !searchBar.hidden || !messageFilterBar.hidden || (!pageNav.hidden && !isViewingLatestPage());
  chatHeaderExpandBtn.classList.toggle('has-hidden-state', hiddenState);
}

/**
 * Loads one forum-thread-style page of `chatId`'s messages — page 1 is the
 * oldest messages, `page` may also be the literal string "last" to fetch
 * whichever page is currently final without the caller needing to already
 * know totalPages (see the route's own docs in routes/chats.js). Replaces
 * the message list wholesale, same as a chat switch.
 *
 * Streaming reconciliation mirrors selectChat's, but scoped to just this
 * chat since only the message list (not the whole chat view) is being
 * swapped: any bubble still attached is detached before the list is wiped
 * (otherwise its DOM node would vanish out from under its still-ticking
 * interval), and reattached afterward ONLY if the page that loaded turned
 * out to be the latest one — an in-progress reply has no natural place on
 * an older, frozen page, so it simply stays un-rendered (data intact in
 * streamingEntries) until the user pages back to the end.
 * @param {string} chatId
 * @param {number | 'last'} page
 * @returns {Promise<void>}
 */
async function loadMessagesPage(chatId, page) {
  const url = new URL(`/api/chats/${chatId}/messages`, location.origin);
  url.searchParams.set('page', String(page));
  const res = await fetch(url);
  const msgs = /** @type {Message[]} */ (await res.json());

  for (const entry of Object.values(streamingEntries)) {
    if (entry.chatId === chatId && entry.el) detachStreamingBubble(entry);
  }

  messageList.innerHTML = '';
  for (const msg of msgs) appendMessage(msg);

  currentPage = Number(res.headers.get('X-Page')) || 1;
  totalPages = Number(res.headers.get('X-Total-Pages')) || 1;
  renderPageNav();

  // appendMessage scrolls to the bottom on every call, which is right for
  // the latest page (jump straight to the newest activity) but wrong for
  // any earlier one — a "page" here means reading from its start, like
  // turning to the top of a book page, not landing on its last line.
  if (!isViewingLatestPage()) messageList.scrollTop = 0;

  if (isViewingLatestPage()) {
    for (const entry of Object.values(streamingEntries)) {
      if (entry.chatId === chatId) attachStreamingBubble(entry);
    }
  }
}

/**
 * Creates and returns a DOM element for an isSystemNote message (currently
 * just a context-compaction report — see Message.isSystemNote's docs) — a
 * single centered line, no avatar/actions/markdown, since it's an aside
 * about the agent rather than something it said. Kept structurally close to
 * buildMessageEl's normal output (same dataset attrs, same filter behavior)
 * so message-list plumbing (jump-to-context, the per-agent filter) doesn't
 * need to special-case it.
 * @param {Message} msg
 * @returns {HTMLElement}
 */
function buildSystemNoteEl(msg) {
  const el = document.createElement('div');
  el.className = 'msg msg-system-note';
  el.dataset.msgId = msg.id;
  el.dataset.testid = 'message';
  el.dataset.role = msg.role;
  el.dataset.agentId = msg.agentId ?? '';
  el.dataset.mentionedIds = '';
  el.hidden = !isVisibleUnderMessageFilter(msg.agentId, []);
  el.innerHTML = `
    <span data-testid="msg-system-note-text">${escHtml(msg.content)}</span>
    <span class="msg-time" data-iso="${msg.createdAt}">${fmtTime(msg.createdAt)}</span>`;
  return el;
}

/**
 * Creates and returns a DOM element for a completed message.
 * @param {Message} msg
 * @returns {HTMLElement}
 */
function buildMessageEl(msg) {
  if (msg.isSystemNote) return buildSystemNoteEl(msg);

  const agent = msg.agentId ? agentById(msg.agentId) : null;
  const color = agentDisplayColor(msg.role === 'user' ? userSettings.userColor : (agent?.color ?? 'var(--muted)'));
  const initial = msg.authorName[0].toUpperCase();
  // Only agent replies are real markdown worth rendering — a user typing
  // "*not markdown*" shouldn't have it silently reinterpreted.
  const contentHtml = msg.role === 'agent' ? renderMarkdown(msg.content) : escHtml(msg.content);

  // Only matters for a user message (agentId null) — see
  // isVisibleUnderMessageFilter's docs for why an agent's own messages
  // don't need this at all. Resolved against ALL known agents, not just
  // current chat members: a message can @mention an agent who has since
  // been removed from the chat, and that history shouldn't collapse into
  // looking like a broadcast just because the mention no longer matches
  // anyone currently present.
  const mentionedIds = msg.agentId ? [] : extractMentionedAgentIds(msg.content, agents);

  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.msgId = msg.id;
  el.dataset.testid = 'message';
  el.dataset.role = msg.role;
  el.dataset.agentId = msg.agentId ?? '';
  el.dataset.mentionedIds = mentionedIds.join(',');
  el.hidden = !isVisibleUnderMessageFilter(msg.agentId, mentionedIds);
  el.style.setProperty('--author-color', color);
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${initial}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author" data-testid="msg-author">${escHtml(msg.authorName)}</span>
        ${agent ? renderProviderBadge(agent, 'msg-author-provider-badge') : ''}
        ${msg.role === 'agent' ? `<button class="msg-mention-btn" data-testid="msg-mention-btn" title="${t('msg.mentionTitle', { name: escHtml(msg.authorName) })}">@</button>` : ''}
        ${agent?.dangerouslySkipPermissions ? `<span class="msg-author-yolo-badge" data-testid="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}
        ${agent?.chromeAccess ? `<span class="msg-author-chrome-badge" data-testid="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}
        ${agent ? `<span class="msg-author-dir" data-testid="msg-author-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>` : ''}
        <span class="msg-time" data-iso="${msg.createdAt}">${fmtTime(msg.createdAt)}</span>
        ${msg.role === 'agent' ? `
        <span class="msg-actions">
          <button class="msg-copy-text-btn" data-testid="msg-copy-text-btn" title="${t('msg.copyTextTitle')}">📋</button>
          <button class="msg-copy-image-btn" data-testid="msg-copy-image-btn" title="${t('msg.copyImageTitle')}">📸</button>
        </span>` : ''}
      </div>
      <div class="msg-content${msg.role === 'user' ? ' msg-content-plain' : ''}" data-testid="msg-content">${contentHtml}</div>
    </div>`;
  if (msg.attachments?.length) {
    el.querySelector('.msg-body').appendChild(buildAttachmentsEl(msg.attachments));
  }
  if (msg.toolCalls?.length) {
    el.querySelector('.msg-body').appendChild(buildToolCallsEl(msg.toolCalls));
  }
  if (msg.role === 'agent') {
    // Prefer the agent's CURRENT name over msg.authorName (a snapshot from
    // when this message was sent) — if the agent's been renamed since,
    // inserting the stale name would produce an @mention nothing resolves.
    el.querySelector('.msg-mention-btn').addEventListener('click', () => quickMention(agent?.name ?? msg.authorName));
    el.querySelector('.msg-copy-text-btn').addEventListener('click', (e) => copyMessageText(e.currentTarget, msg.content));
    el.querySelector('.msg-copy-image-btn').addEventListener('click', (e) => copyMessageAsImage(e.currentTarget, el));
  }
  decorateCodeBlocks(el);
  return el;
}

/**
 * Briefly swaps a button's label to a status glyph (success/failure), then
 * restores it, mirroring the "Copied!" feedback used for session-ID copying.
 * @param {HTMLButtonElement} btn
 * @param {string} glyph
 */
function flashButtonStatus(btn, glyph) {
  const original = btn.textContent;
  btn.textContent = glyph;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

/**
 * Copies a message's raw text content to the clipboard.
 * @param {HTMLButtonElement} btn
 * @param {string} content
 */
async function copyMessageText(btn, content) {
  try {
    await navigator.clipboard.writeText(content);
    flashButtonStatus(btn, '✓');
  } catch (err) {
    console.error('Failed to copy message text:', err);
    flashButtonStatus(btn, '✗');
  }
}

/**
 * Drops a copy button into every code block markdown.js wrapped in a
 * `.md-code-wrap` container that doesn't already have one — called after
 * every markdown re-render (a first render, or a streaming chunk arriving)
 * since content is replaced wholesale via innerHTML each time. Click
 * handling itself is delegated on messageList (see below), not attached
 * here, so this only ever needs to add the button, never rewire it.
 * @param {HTMLElement} container
 */
function decorateCodeBlocks(container) {
  for (const wrap of container.querySelectorAll('.md-code-wrap')) {
    if (wrap.querySelector('.md-code-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-code-copy-btn';
    btn.title = t('msg.copyCodeTitle');
    btn.textContent = '📋';
    wrap.prepend(btn);
  }
}

/**
 * Copies a single code block's raw text to the clipboard. Reads straight
 * from the sibling <code> element's textContent rather than from any
 * attribute on the button — markdown.js deliberately doesn't stash a copy
 * of the code there (see markdown.js's renderer.code), so this is the only
 * place that ever needs the text.
 * @param {HTMLButtonElement} btn
 */
async function copyCodeBlock(btn) {
  const code = btn.parentElement.querySelector('pre code');
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    flashButtonStatus(btn, '✓');
  } catch (err) {
    console.error('Failed to copy code block:', err);
    flashButtonStatus(btn, '✗');
  }
}

// Delegated on messageList (not per-button) because code blocks are added
// via innerHTML on every markdown render, including once per streaming
// chunk — a per-button listener would need constant rewiring, and
// flashButtonStatus's textContent swap would race a mid-flash re-render.
messageList.addEventListener('click', (e) => {
  const btn = e.target.closest('.md-code-copy-btn');
  if (btn) copyCodeBlock(btn);
});

/**
 * Traces a rounded-rect path on a canvas context (no native roundRect
 * fallback needed, but this keeps rendering independent of that API).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function traceRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Block-level tags that should end their own line when flattening rendered
 * markdown down to plain text (see blockText) — covers nested lists (an
 * <li>'s own text and any nested <ul>/<ol> inside it are separate <li>
 * elements themselves) and tables (each <tr> is one line) without needing
 * to special-case container tags like <ul>/<table>/<tbody> at all. */
const BLOCK_TAGS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, hr';

/**
 * Flattens an element's text for the copy-as-image export. Plain
 * `.textContent` concatenates every descendant text node with NO separator
 * at all regardless of CSS display/block boundaries (DOM behavior, not a
 * bug) — fine for a single paragraph, but a rendered markdown list would
 * otherwise flatten to "item oneitem two". Works on a clone (never touches
 * the live, on-screen DOM): inserts a newline marker right after every
 * block-level element, then reads the whole thing back as one string —
 * naturally handles nesting since each block tag's marker lands in
 * document order relative to the others, without hand-walking the tree.
 * Falls back cleanly to plain single-line content (e.g. a user's own
 * message) since it's a no-op when there's nothing to mark.
 * @param {Element} el
 * @returns {string}
 */
function blockText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(BLOCK_TAGS).forEach((node) => {
    node.after(document.createTextNode('\n'));
  });
  return clone.textContent.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Greedily wraps text to fit within maxWidth: splits first on explicit
 * newlines (message content uses white-space: pre-wrap, so they're real line
 * breaks), then on spaces. A single word wider than maxWidth is kept whole
 * rather than hard-broken — good enough for a copy-as-image utility; it
 * doesn't need to byte-for-byte match the browser's own line breaks.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') { lines.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Renders a message bubble to a PNG and copies it to the clipboard as an
 * image, by drawing each part (background, avatar, author, timestamp,
 * content, attachment thumbnails) directly with the Canvas 2D API at the
 * exact positions the browser already laid them out at (via
 * getBoundingClientRect). Deliberately avoids the more obvious "serialize to
 * SVG <foreignObject>, draw that onto canvas" approach — Chromium taints any
 * canvas an SVG-with-foreignObject was drawn onto, permanently blocking
 * toBlob/toDataURL, so that route can never produce an exportable image.
 * Drawing only canvas primitives (fillRect/fillText/drawImage) sidesteps
 * tainting entirely and needs no third-party screenshot library.
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} msgEl - The .msg element to capture
 */
async function copyMessageAsImage(btn, msgEl) {
  try {
    const rect = msgEl.getBoundingClientRect();
    const msgStyle = getComputedStyle(msgEl);
    const scale = window.devicePixelRatio || 1;

    const canvas = document.createElement('canvas');
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    traceRoundedRect(ctx, 0, 0, rect.width, rect.height, parseFloat(msgStyle.borderRadius) || 0);
    ctx.fillStyle = msgStyle.backgroundColor;
    ctx.fill();
    const borderWidth = parseFloat(msgStyle.borderLeftWidth) || 0;
    if (borderWidth > 0) {
      ctx.fillStyle = msgStyle.borderLeftColor;
      ctx.fillRect(0, 0, borderWidth, rect.height);
    }

    /**
     * Draws a text element's own content at its real rendered position.
     * @param {Element | null} el
     * @param {{ align?: CanvasTextAlign, baseline?: CanvasTextBaseline }} [opts]
     */
    const drawTextEl = (el, { align = 'left', baseline = 'alphabetic' } = {}) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      ctx.font = cs.font;
      ctx.fillStyle = cs.color;
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      const x = align === 'center' ? r.left - rect.left + r.width / 2 : r.left - rect.left;
      const y = baseline === 'middle' ? r.top - rect.top + r.height / 2 : r.bottom - rect.top - 1;
      ctx.fillText(el.textContent, x, y);
    };

    const avatarEl = msgEl.querySelector('.msg-avatar');
    if (avatarEl) {
      const r = avatarEl.getBoundingClientRect();
      const cx = r.left - rect.left + r.width / 2;
      const cy = r.top - rect.top + r.height / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(avatarEl).backgroundColor;
      ctx.fill();
      drawTextEl(avatarEl, { align: 'center', baseline: 'middle' });
    }

    drawTextEl(msgEl.querySelector('.msg-author'));
    drawTextEl(msgEl.querySelector('.msg-time'));

    const contentEl = msgEl.querySelector('.msg-content');
    if (contentEl) {
      const r = contentEl.getBoundingClientRect();
      const cs = getComputedStyle(contentEl);
      ctx.font = cs.font;
      ctx.fillStyle = cs.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const x = r.left - rect.left;
      let y = r.top - rect.top + lineHeight * 0.8;
      for (const line of wrapCanvasText(ctx, blockText(contentEl), r.width)) {
        ctx.fillText(line, x, y);
        y += lineHeight;
      }
    }

    for (const img of msgEl.querySelectorAll('.msg-attachment-img')) {
      const r = img.getBoundingClientRect();
      ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
    }

    for (const details of msgEl.querySelectorAll('.msg-attachment-text')) {
      const r = details.getBoundingClientRect();
      const cs = getComputedStyle(details);
      traceRoundedRect(ctx, r.left - rect.left, r.top - rect.top, r.width, r.height, parseFloat(cs.borderRadius) || 0);
      ctx.fillStyle = cs.backgroundColor;
      ctx.fill();
      drawTextEl(details.querySelector('summary'));
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flashButtonStatus(btn, '✓');
  } catch (err) {
    console.error('Failed to copy message as image:', err);
    flashButtonStatus(btn, '✗');
  }
}

/**
 * Shows `src` full-size in the lightbox overlay.
 *
 * Not `window.open(src, '_blank')`: `src` here is a `data:` URI (attachment
 * images are embedded inline, never uploaded to a URL of their own), and
 * Chrome blocks top-level navigation of a newly opened tab straight to a
 * `data:` URL — the tab opens but silently stays blank, no error surfaced.
 * Rendering it in an in-page overlay sidesteps that restriction entirely.
 * @param {string} src
 * @param {string} alt
 * @returns {void}
 */
function openImageLightbox(src, alt) {
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt;
  imageLightboxOverlay.hidden = false;
}

/** @returns {void} */
function closeImageLightbox() {
  imageLightboxOverlay.hidden = true;
  imageLightboxImg.src = '';
}

/**
 * Builds the attachments block appended below a message's text content.
 * @param {Attachment[]} attachments
 * @returns {HTMLElement}
 */
function buildAttachmentsEl(attachments) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-attachments';
  wrap.dataset.testid = 'msg-attachments';
  for (const att of attachments) {
    if (att.type === 'image') {
      const img = document.createElement('img');
      img.className = 'msg-attachment-img';
      img.dataset.testid = 'msg-attachment-image';
      img.src = `data:${att.mediaType};base64,${att.data}`;
      img.alt = att.name ?? t('attachments.pastedImageAlt');
      img.addEventListener('click', () => openImageLightbox(img.src, img.alt));
      wrap.appendChild(img);
    } else {
      const details = document.createElement('details');
      details.className = 'msg-attachment-text';
      details.dataset.testid = 'msg-attachment-text';
      details.innerHTML = `<summary>${escHtml(att.name ?? t('attachments.defaultPastedTextLabel'))}</summary><pre>${escHtml(att.data)}</pre>`;
      wrap.appendChild(details);
    }
  }
  return wrap;
}

/**
 * Builds a single tool call's own expandable entry (label + result), shared
 * by both the flat and accordion-wrapped layouts in buildToolCallsEl.
 * @param {import('../services/agentProcessManager.js').ToolCall} call
 * @returns {HTMLElement}
 */
function buildToolCallEl(call) {
  const details = document.createElement('details');
  details.className = `msg-tool-call${call.isError ? ' msg-tool-call-error' : ''}`;
  details.dataset.testid = 'msg-tool-call';
  const resultText = call.result || `(${t('msg.toolCallNoOutput')})`;
  details.innerHTML = `
    <summary>${call.isError ? `<span class="msg-tool-call-error-badge">${escHtml(t('msg.toolCallErrorLabel'))}</span> ` : ''}${escHtml(call.label)}</summary>
    <pre>${escHtml(resultText)}</pre>`;
  return details;
}

/**
 * Renders a message's tool calls as collapsed, click-to-expand entries —
 * same idea as the VS Code Claude Code extension's expandable tool-call
 * blocks, scaled down to fit a multi-agent group chat: collapsed by
 * default so several agents narrating their work at once doesn't drown out
 * the actual conversation, but the real output (command results, diffs, MCP
 * responses) is one click away instead of being discarded entirely.
 *
 * A single call is shown directly — one accordion is already minimal. Two
 * or more get nested inside an outer accordion too: an agent that made a
 * dozen tool calls was otherwise a dozen collapsed-but-still-one-line
 * entries stacked in the message, which on its own was already enough
 * height to crowd out the actual conversation this is a CHAT for. The outer
 * summary surfaces an error badge up front (matching each inner entry's own
 * badge) so a failure is visible without expanding anything.
 * @param {import('../services/agentProcessManager.js').ToolCall[]} toolCalls
 * @returns {HTMLElement}
 */
function buildToolCallsEl(toolCalls) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-tool-calls';
  wrap.dataset.testid = 'msg-tool-calls';

  if (toolCalls.length <= 1) {
    for (const call of toolCalls) wrap.appendChild(buildToolCallEl(call));
    return wrap;
  }

  const hasError = toolCalls.some((call) => call.isError);
  const outer = document.createElement('details');
  outer.className = `msg-tool-calls-outer${hasError ? ' msg-tool-call-error' : ''}`;
  outer.dataset.testid = 'msg-tool-calls-outer';
  const summary = document.createElement('summary');
  summary.innerHTML = `${hasError ? `<span class="msg-tool-call-error-badge">${escHtml(t('msg.toolCallErrorLabel'))}</span> ` : ''}${escHtml(t('msg.toolCallsSummary', { count: toolCalls.length }))}`;
  outer.appendChild(summary);
  const inner = document.createElement('div');
  inner.className = 'msg-tool-calls-inner';
  for (const call of toolCalls) inner.appendChild(buildToolCallEl(call));
  outer.appendChild(inner);
  wrap.appendChild(outer);
  return wrap;
}

/**
 * Appends a completed message to the message list.
 * @param {Message} msg
 */
function appendMessage(msg) {
  if ($(`[data-msg-id="${msg.id}"]`)) return; // dedup
  messageList.appendChild(buildMessageEl(msg));
  scrollToBottom();
}

/**
 * Creates a streaming bubble placeholder for an in-progress agent response.
 * @param {string} agentId
 * @param {string} agentName
 * @param {string} agentColor
 * @returns {HTMLElement}
 */
function createStreamingBubble(agentId, agentName, agentColor) {
  const agent = agentById(agentId);
  const color = agentDisplayColor(agentColor);
  const el = document.createElement('div');
  el.className = 'msg streaming';
  el.dataset.testid = 'streaming-bubble';
  el.dataset.agentId = agentId ?? '';
  el.hidden = !isVisibleUnderMessageFilter(agentId);
  el.style.setProperty('--author-color', color);
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${agentName[0].toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author">${escHtml(agentName)}</span>
        ${agent ? renderProviderBadge(agent, 'msg-author-provider-badge') : ''}
        ${agent?.dangerouslySkipPermissions ? `<span class="msg-author-yolo-badge" data-testid="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}
        ${agent?.chromeAccess ? `<span class="msg-author-chrome-badge" data-testid="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}
        ${agent ? `<span class="msg-author-dir" data-testid="msg-author-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>` : ''}
        <span class="msg-typing" data-testid="msg-typing">
          <span class="msg-status-text" data-testid="msg-status-text">${t('chat.respondingLabel')}</span>
          <span class="msg-elapsed" data-testid="msg-elapsed"></span>
        </span>
        <button class="msg-stop-btn" data-testid="stream-stop-btn" title="${t('chat.stopTitle')}">⏹ ${t('chat.stopBtn')}</button>
      </div>
      <div class="msg-content" data-testid="msg-content"></div>
    </div>`;
  return el;
}

/**
 * Escapes a string for safe innerHTML insertion.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Chat list rendering ─────────────────────────────────────────────────────

/** localStorage key for the set of collapsed category names (sidebar-only UI state, not server-persisted). */
const COLLAPSED_CATEGORIES_STORAGE_KEY = 'collapsedCategories';
/** Sentinel group key for chats with no category — an empty string can't collide with a real category name, since both the client and server normalize blank input to `null`/uncategorized. */
const UNCATEGORIZED_KEY = '';

/**
 * Reads the set of collapsed category names from localStorage. Falls back to
 * an empty set on missing/corrupt data or a storage access error (private
 * browsing, disabled storage) — same defensive shape as other localStorage
 * reads in this app.
 * @returns {Set<string>}
 */
function getCollapsedCategories() {
  try {
    const raw = localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/**
 * @param {Set<string>} collapsed
 * @returns {void}
 */
function setCollapsedCategories(collapsed) {
  try {
    localStorage.setItem(COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage disabled/full — collapse state just won't survive a reload.
  }
}

/**
 * Builds one chat's `<li>` row (name, tag/rename/delete buttons), identical
 * markup to before category grouping existed except for the added tag
 * button. Extracted out of renderChatList so it can be called once per chat
 * per category group instead of once per chat overall.
 * @param {Chat} chat
 * @returns {HTMLLIElement}
 */
function buildChatItem(chat) {
  const li = document.createElement('li');
  const unread = unreadChatIds.has(chat.id);
  li.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '') + (unread ? ' has-unread' : '') + (isChatBusy(chat.id) ? ' is-busy' : '');
  li.dataset.chatId = chat.id;
  li.dataset.testid = 'chat-item';
  li.innerHTML = `
    ${unread ? `<span class="chat-unread-dot" data-testid="chat-unread-dot" title="${t('chat.unreadTitle')}"></span>` : ''}
    <span class="chat-item-name" data-testid="chat-item-name" title="${escHtml(chat.name)}">${t('chat.channelName', { name: escHtml(chat.name) })}</span>
    <span class="typing-dots chat-busy-dots" data-testid="chat-busy-dots" title="${t('chat.busyTitle')}"><i></i><i></i><i></i></span>
    <button class="chat-tag-btn" data-testid="chat-tag-btn" data-tag-chat="${chat.id}" title="${t('category.assignTitle')}">🏷️</button>
    <button class="chat-rename-btn" data-testid="chat-rename-btn" data-rename-chat="${chat.id}" title="${t('chat.renameTitle')}">✏️</button>
    <button class="chat-del-btn" data-testid="chat-del-btn" data-del-chat="${chat.id}" title="${t('chat.deleteTitle')}">×</button>
    <ul class="category-menu" data-testid="category-menu" hidden></ul>`;
  li.addEventListener('click', (e) => {
    if (e.target.closest('[data-del-chat], [data-rename-chat], [data-tag-chat]')) return;
    selectChat(chat.id, { push: true });
  });
  li.querySelector('[data-tag-chat]').addEventListener('click', (e) => {
    e.stopPropagation();
    openCategoryMenu(chat, li);
  });
  li.querySelector('[data-rename-chat]').addEventListener('click', (e) => {
    e.stopPropagation();
    startRenameChat(chat, li);
  });
  li.querySelector('[data-del-chat]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const memberCount = chat.memberAgentIds.length;
    const opts = memberCount > 0
      ? { checkboxLabel: t('confirm.deleteChatAgentsCheckbox', { count: memberCount }) }
      : {};
    const { confirmed, checked } = await confirmDialog(t('confirm.deleteChat', { name: chat.name }), opts);
    if (confirmed) deleteChat(chat.id, checked);
  });
  return li;
}

/**
 * Groups `chats` by category into collapsible `<details>` sections
 * (Uncategorized first, then named categories alphabetically), each holding
 * its chats' `<li>` rows built by buildChatItem. Collapse state persists to
 * localStorage per category name. A category's rename/delete controls live
 * in its `<summary>` (Uncategorized gets neither, since it isn't a real
 * category to rename or delete).
 */
function renderChatList() {
  // The strip that restores a collapsed chat list says when a chat has
  // something unread, since the list itself can't.
  sidebarExpandBtn.classList.toggle('has-hidden-state', unreadChatIds.size > 0);
  chatList.innerHTML = '';

  const groups = new Map();
  for (const chat of chats) {
    const key = chat.category || UNCATEGORIZED_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chat);
  }

  const namedKeys = [...groups.keys()].filter((k) => k !== UNCATEGORIZED_KEY).sort((a, b) => a.localeCompare(b));
  const orderedKeys = groups.has(UNCATEGORIZED_KEY) ? [UNCATEGORIZED_KEY, ...namedKeys] : namedKeys;
  const collapsed = getCollapsedCategories();

  for (const key of orderedKeys) {
    const groupChats = groups.get(key);
    const isUncategorized = key === UNCATEGORIZED_KEY;

    const details = document.createElement('details');
    details.className = 'chat-category';
    details.dataset.testid = 'chat-category';
    details.open = !collapsed.has(key);
    details.addEventListener('toggle', () => {
      const next = getCollapsedCategories();
      if (details.open) next.delete(key); else next.add(key);
      setCollapsedCategories(next);
    });

    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="chat-category-name" data-testid="chat-category-name">${isUncategorized ? t('category.uncategorizedLabel') : escHtml(key)}</span>
      <span class="chat-category-count">${groupChats.length}</span>
      ${isUncategorized ? '' : `
        <button class="chat-category-rename-btn" data-testid="chat-category-rename-btn" title="${t('category.renameTitle')}">✏️</button>
        <button class="chat-category-del-btn" data-testid="chat-category-del-btn" title="${t('category.deleteTitle')}">×</button>`}`;
    if (!isUncategorized) {
      summary.querySelector('.chat-category-rename-btn').addEventListener('click', (e) => {
        e.preventDefault(); // don't also toggle the <details> open state
        e.stopPropagation();
        renameCategory(key);
      });
      summary.querySelector('.chat-category-del-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteCategory(key, groupChats.length);
      });
    }
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'chat-category-list';
    for (const chat of groupChats) ul.appendChild(buildChatItem(chat));
    details.appendChild(ul);

    chatList.appendChild(details);
  }
}

/**
 * Swaps a sidebar chat item's name span for a text input so it can be
 * renamed in place. Commits via PATCH on Enter or blur (fetch-then-patch-
 * local-state, same pattern as toggleFreeRelay/toggleAutoContinue); Escape
 * or a blank/unchanged value cancels without a network call. Either way
 * ends with a renderChatList() to rebuild the row from current state.
 * @param {Chat} chat
 * @param {HTMLElement} li
 */
function startRenameChat(chat, li) {
  const nameSpan = li.querySelector('[data-testid="chat-item-name"]');
  if (!nameSpan || li.querySelector('.chat-rename-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-rename-input';
  input.dataset.testid = 'chat-rename-input';
  input.value = chat.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== chat.name) {
      const res = await fetch(`/api/chats/${chat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        const updated = /** @type {Chat} */ (await res.json());
        const idx = chats.findIndex((c) => c.id === updated.id);
        if (idx !== -1) chats[idx] = updated;
        if (chat.id === activeChatId) {
          chatTopbarName.textContent = t('chat.channelName', { name: updated.name });
        }
      }
    }
    renderChatList();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * Closes every open category-picker popover (there should only ever be one,
 * but this is called defensively before opening another).
 */
function closeAllCategoryMenus() {
  for (const menu of chatList.querySelectorAll('.category-menu:not([hidden])')) {
    menu.hidden = true;
  }
}

/**
 * Opens (or, on a second click, closes) the category-picker popover for one
 * sidebar chat row: every category already in use across `chats` is a
 * one-click row — no retyping a name that already exists, unlike the old
 * free-text input (backed by a `<datalist>`, whose browser-native suggestion
 * popup turned out to be easy to miss) — plus "Uncategorized" to clear (only
 * shown when the chat currently has a category) and a "+ New category" row
 * that reveals an inline text input for a name that doesn't exist yet.
 * @param {Chat} chat
 * @param {HTMLElement} li
 */
function openCategoryMenu(chat, li) {
  const menu = li.querySelector('.category-menu');
  if (!menu) return;
  const wasHidden = menu.hidden;
  closeAllCategoryMenus();
  if (!wasHidden) return;

  const commit = async (category) => {
    menu.hidden = true;
    if (category === (chat.category ?? null)) return;
    const res = await fetch(`/api/chats/${chat.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    if (res.ok) {
      const updated = /** @type {Chat} */ (await res.json());
      const idx = chats.findIndex((c) => c.id === updated.id);
      if (idx !== -1) chats[idx] = updated;
    }
    renderChatList();
  };

  const existingCategories = [...new Set(chats.map((c) => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  menu.innerHTML = '';
  if (chat.category) {
    const clearItem = document.createElement('li');
    clearItem.innerHTML = `<button data-testid="category-menu-clear">${t('category.uncategorizedLabel')}</button>`;
    clearItem.querySelector('button').addEventListener('click', () => commit(null));
    menu.appendChild(clearItem);
  }
  for (const name of existingCategories) {
    const item = document.createElement('li');
    item.innerHTML = `<button class="${name === chat.category ? 'active' : ''}" data-testid="category-menu-item">${escHtml(name)}</button>`;
    item.querySelector('button').addEventListener('click', () => commit(name));
    menu.appendChild(item);
  }
  const newItem = document.createElement('li');
  newItem.innerHTML = `<button data-testid="category-menu-new-btn">+ ${t('category.newCategoryOption')}</button>`;
  newItem.querySelector('button').addEventListener('click', (e) => {
    // Stop the bubble here — swapping this button for an input below detaches
    // it from the DOM before the event finishes propagating, so the
    // document-level "click outside" listener would otherwise see a
    // disconnected e.target (.closest() returns null on it) and immediately
    // close the menu this click just opened.
    e.stopPropagation();
    newItem.innerHTML = `<input type="text" class="category-menu-input" data-testid="category-menu-input" placeholder="${t('category.newCategoryPlaceholder')}" />`;
    const input = newItem.querySelector('input');
    input.focus();
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; }
    });
    input.addEventListener('blur', () => {
      const value = input.value.trim();
      if (value) commit(value); else menu.hidden = true;
    });
  });
  menu.appendChild(newItem);

  menu.hidden = false;
}

/**
 * Prompts for a new name for `oldName` and, if confirmed with a real change,
 * bulk-renames it across every chat that has it via PATCH /api/chats/category,
 * then does a full resync of `chats` (same fallback pattern addMember uses)
 * since the bulk endpoint doesn't return the affected chats individually.
 * @param {string} oldName
 * @returns {Promise<void>}
 */
async function renameCategory(oldName) {
  const { confirmed, value } = await confirmDialog(
    t('confirm.renameCategory', { name: oldName }),
    { textInput: { value: oldName }, okLabel: t('confirm.renameBtn') },
  );
  const newName = value.trim();
  if (!confirmed || !newName || newName === oldName) return;
  await fetch('/api/chats/category', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: oldName, to: newName }),
  });
  chats = await (await fetch('/api/chats')).json();
  renderChatList();
}

/**
 * Confirms then clears `name` from every chat that has it (they fall back to
 * Uncategorized) via PATCH /api/chats/category with `to: null`, same
 * full-resync-after pattern as renameCategory.
 * @param {string} name
 * @param {number} count - Chats currently in this category, shown in the confirm prompt.
 * @returns {Promise<void>}
 */
async function deleteCategory(name, count) {
  const { confirmed } = await confirmDialog(t('confirm.deleteCategory', { name, count }));
  if (!confirmed) return;
  await fetch('/api/chats/category', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: name, to: null }),
  });
  chats = await (await fetch('/api/chats')).json();
  renderChatList();
}

// ─── Agent panel rendering ───────────────────────────────────────────────────

/** Hides every open per-agent overflow menu (at most one is open at a time). */
function closeAllAgentMenus() {
  for (const menu of agentList.querySelectorAll('.agent-menu:not([hidden])')) {
    menu.hidden = true;
  }
}

function renderAgentPanel() {
  // Same for a collapsed agent panel: a dot while an agent has activity
  // you haven't seen (see unseenOutsideFocusAgentIds).
  agentPanelExpandBtn.classList.toggle('has-hidden-state', unseenOutsideFocusAgentIds.size > 0);
  const chat = activeChat();
  if (!chat) {
    noChatNotice.hidden = false;
    agentList.hidden = true;
    agentActions.hidden = true;
    return;
  }
  noChatNotice.hidden = true;
  agentList.hidden = false;
  agentActions.hidden = false;
  agentPanelError.hidden = true;

  // Member list
  const members = chat.memberAgentIds.map(agentById).filter(Boolean);
  agentList.innerHTML = '';
  for (const agent of members) {
    const display = providerDisplayFor(agent.provider);
    const hasUnseen = unseenOutsideFocusAgentIds.has(agent.id);
    const li = document.createElement('li');
    li.className = 'agent-item' + (hasUnseen ? ' has-unseen-outside-focus' : '') + (isAgentStreaming(agent.id) ? ' is-streaming' : '');
    li.dataset.testid = 'agent-item';
    li.dataset.agentId = agent.id;
    li.innerHTML = `
      <div class="agent-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0].toUpperCase()}</div>
      <div class="agent-info">
        <span class="agent-name" data-testid="agent-name"><span title="${providerTitle(agent)}">${escHtml(agent.name)}</span>${hasUnseen ? ` <span class="agent-unseen-dot" data-testid="agent-unseen-dot" title="${t('agent.unseenOutsideFocusTitle', { name: agent.name })}"></span>` : ''}${agent.dangerouslySkipPermissions ? ` <span class="agent-yolo-badge" data-testid="agent-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}${agent.isObserver ? ` <span class="agent-observer-badge" data-testid="agent-observer-badge" title="${t('agent.observerBadgeTitle')}">👁</span>` : ''}${agent.chromeAccess ? ` <span class="agent-chrome-badge" data-testid="agent-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}</span>
        <span class="agent-streaming" data-testid="agent-streaming"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span> ${t('chat.respondingLabel')}</span>
        <span class="agent-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>
        ${agent.model ? `<span class="agent-model" data-testid="agent-model" title="${t('agent.modelTitle', { model: escHtml(agent.model) })}">🧠 ${escHtml(display.formatModel(agent.model))}</span>` : ''}
        ${renderUsageBadge(agent)}
        ${renderBackgroundTasksBadge(agent)}
        ${isSessionLimited(agent) ? `<span class="agent-session-limit" data-testid="agent-session-limit" title="${escHtml(t('agent.sessionLimitBadgeTitle', { time: fmtFullTime(agent.sessionLimitResetAt) }))}">⏳ ${t('agent.sessionLimitBadgeLabel', { time: fmtScheduledTime(agent.sessionLimitResetAt) })}</span>` : ''}
        ${agent.note ? `<span class="agent-note" data-testid="agent-note" title="${escHtml(agent.note)}">📝 ${escHtml(agent.note)}</span>` : ''}
        ${agent.resumeId ? `<button class="agent-session-btn" data-testid="agent-session-btn" title="${t('agent.copySessionTitle', { command: escHtml(display.resumeCommand(agent.resumeId)) })}">⧉ ${agent.resumeId.slice(0, 8)}…</button>` : ''}
      </div>
      <button class="agent-filter-btn${messageFilterAgentIds.has(agent.id) ? ' active' : ''}" data-testid="agent-filter-btn" title="${messageFilterAgentIds.has(agent.id) ? t('agent.filterOffTitle', { name: agent.name }) : t('agent.filterOnTitle', { name: agent.name })}">🔎</button>
      <div class="agent-menu-wrap">
        <button class="agent-menu-btn" data-testid="agent-menu-btn" title="${t('agent.moreActionsTitle')}">⋮</button>
        <ul class="agent-menu" data-testid="agent-menu" hidden>
          <li><button class="agent-note-btn" data-testid="agent-note-btn">🗒 ${agent.note ? t('agent.editNoteTitle') : t('agent.addNoteTitle')}</button></li>
          <li><button class="agent-model-btn" data-testid="agent-model-btn">🧠 ${t('agent.switchModelTitle')}</button></li>
          ${display.autocompact ? `<li><button class="agent-autocompact-btn" data-testid="agent-autocompact-btn">🗜️ ${agent.autocompactOverride ? t('agent.autocompactTitle', { value: agent.autocompactOverride }) : t('agent.autocompactDefaultTitle', { value: effectiveDefaultAutocompact() })}</button></li>` : ''}
          ${agent.dangerouslySkipPermissions ? '' : `<li><button class="agent-grants-btn" data-testid="agent-grants-btn">🔐 ${t('agent.grantsTitle')}</button></li>`}
          <li><button class="agent-open-folder-btn" data-testid="agent-open-folder-btn">📂 ${t('agent.openFolderTitle')}</button></li>
          <li><button class="agent-restart-btn" data-testid="agent-restart-btn" title="${t('agent.restartHint')}">🔄 ${t('agent.restartTitle')}</button></li>
          <li><button class="agent-remove-btn" data-testid="agent-remove-btn">× ${t('agent.removeFromChatTitle')}</button></li>
          <li><button class="agent-del-btn" data-testid="agent-del-btn">🗑 ${t('agent.deleteTitle')}</button></li>
        </ul>
      </div>`;
    const agentMenu = li.querySelector('.agent-menu');
    const closeAgentMenu = () => { agentMenu.hidden = true; };
    li.querySelector('.agent-filter-btn').addEventListener('click', () => toggleMessageFilter(agent.id));
    li.querySelector('.agent-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = agentMenu.hidden;
      closeAllAgentMenus();
      agentMenu.hidden = !wasHidden;
    });
    li.querySelector('.agent-note-btn').addEventListener('click', () => { closeAgentMenu(); openNoteModal(agent); });
    li.querySelector('.agent-model-btn').addEventListener('click', () => { closeAgentMenu(); changeAgentModel(agent); });
    li.querySelector('.agent-autocompact-btn')?.addEventListener('click', () => { closeAgentMenu(); changeAgentAutocompact(agent); });
    li.querySelector('.agent-grants-btn')?.addEventListener('click', () => { closeAgentMenu(); openGrantsModal(agent.id); });
    li.querySelector('.agent-open-folder-btn').addEventListener('click', () => { closeAgentMenu(); openAgentFolder(agent); });
    li.querySelector('.agent-restart-btn').addEventListener('click', () => { closeAgentMenu(); restartAgent(agent); });
    li.querySelector('.agent-remove-btn').addEventListener('click', () => { closeAgentMenu(); removeMember(agent.id); });
    li.querySelector('.agent-del-btn').addEventListener('click', async () => {
      closeAgentMenu();
      const { confirmed } = await confirmDialog(t('confirm.deleteAgent', { name: agent.name }));
      if (confirmed) deleteGlobalAgent(agent.id);
    });
    li.querySelector('.agent-session-btn')?.addEventListener('click', () => copySessionCommand(agent));
    agentList.appendChild(li);
  }

  // Add-agent dropdown contents — an agent belongs to at most one chat at a
  // time, so exclude anyone busy in ANY chat, not just this one (a strict
  // superset of "already in this chat", since this chat's own members are
  // necessarily part of that union too).
  const busyAgentIds = new Set(chats.flatMap((c) => c.memberAgentIds));
  const available = agents.filter((a) => !busyAgentIds.has(a.id));
  addAgentBtn.hidden = available.length === 0;
  addAgentMenu.innerHTML = '';
  for (const agent of available) {
    const li = document.createElement('li');
    li.className = 'add-menu-item';
    li.dataset.testid = 'add-menu-item';
    li.dataset.agentId = agent.id;
    li.innerHTML = `
      <span class="add-menu-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0]}</span>
      <span class="add-menu-name" title="${providerTitle(agent)}">${escHtml(agent.name)}</span>
      <button class="agent-del-btn" data-testid="agent-del-btn" title="${t('agent.deleteTitle')}">🗑</button>`;
    li.querySelector('.add-menu-name').addEventListener('click', () => addMember(agent.id));
    li.querySelector('.add-menu-avatar').addEventListener('click', () => addMember(agent.id));
    li.querySelector('.agent-del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const { confirmed } = await confirmDialog(t('confirm.deleteAgent', { name: agent.name }));
      if (confirmed) deleteGlobalAgent(agent.id);
    });
    addAgentMenu.appendChild(li);
  }
}

/**
 * Opens the note modal for a given agent, pre-filled with its current note
 * (if any). Purely a user-facing reminder (never sent to the CLI), and
 * unlike workingDir/YOLO/Observer/chromeAccess it's editable any time — see
 * the note field's docs in server/store/db.js for why that's safe (no
 * spawn-arg implications).
 * @param {Agent} agent
 * @returns {void}
 */
function openNoteModal(agent) {
  noteEditAgentId = agent.id;
  noteHeaderTitle.textContent = agent.note ? t('agent.editNoteTitle') : t('agent.addNoteTitle');
  noteTextarea.value = agent.note ?? '';
  noteOverlay.hidden = false;
  noteTextarea.focus();
}

/**
 * Opens the saved-permissions modal for an agent: every directory and tool
 * pattern its Grant clicks have saved, each with a Revoke button. Re-rendered
 * on every AGENT_UPDATED for the same agent while open, so a grant made or
 * revoked elsewhere shows up here too.
 * @param {string} agentId
 * @returns {void}
 */
function openGrantsModal(agentId) {
  grantsAgentId = agentId;
  renderGrantsModal();
  grantsOverlay.hidden = false;
}

function closeGrantsModal() {
  grantsOverlay.hidden = true;
  grantsAgentId = null;
}

function renderGrantsModal() {
  const agent = agentById(grantsAgentId);
  if (!agent) return closeGrantsModal();
  grantsHeaderTitle.textContent = `${t('agent.grantsTitle')}: ${agent.name}`;
  const grants = [
    ...(agent.extraAllowedPaths ?? []).map((path) => ({ path, label: t('agent.grantsFolderLabel'), text: path })),
    ...(agent.allowedToolPatterns ?? []).map((pattern) => ({ pattern, label: t('agent.grantsRuleLabel'), text: pattern })),
  ];
  grantsEmpty.hidden = grants.length > 0;
  grantsList.innerHTML = '';
  for (const grant of grants) {
    const li = document.createElement('li');
    li.className = 'grants-item';
    li.dataset.testid = 'grants-item';
    li.innerHTML = `
      <span class="grants-kind">${escHtml(grant.label)}</span>
      <code class="grants-text" title="${escHtml(grant.text)}">${escHtml(grant.text)}</code>
      <button class="grants-revoke-btn" data-testid="grants-revoke-btn">${t('agent.revokeGrantBtn')}</button>`;
    const revokeBtn = li.querySelector('.grants-revoke-btn');
    revokeBtn.addEventListener('click', async () => {
      revokeBtn.disabled = true;
      const res = await fetch(`/api/agents/${agent.id}/grants`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(grant.path !== undefined ? { path: grant.path } : { pattern: grant.pattern }),
      });
      if (res.ok) {
        const updated = /** @type {Agent} */ (await res.json());
        const idx = agents.findIndex((a) => a.id === agent.id);
        if (idx !== -1) agents[idx] = updated;
      }
      if (grantsAgentId === agent.id) renderGrantsModal();
    });
    grantsList.appendChild(li);
  }
}

function closeNoteModal() {
  noteOverlay.hidden = true;
  noteEditAgentId = null;
}

/**
 * Persists the note modal's textarea via PATCH (never evicts the running
 * process — see the PATCH route's docs), updates local state, and re-renders.
 * @param {SubmitEvent} e
 * @returns {Promise<void>}
 */
async function handleNoteFormSubmit(e) {
  e.preventDefault();
  const agentId = noteEditAgentId;
  const note = noteTextarea.value.trim();
  closeNoteModal();

  const res = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (res.ok) {
    const updated = /** @type {Agent} */ (await res.json());
    const idx = agents.findIndex((a) => a.id === agentId);
    if (idx !== -1) agents[idx] = updated;
  }
  renderAgentPanel();
}

/**
 * Prompts for a model override (a family alias like "opus"/"sonnet"/"fable",
 * or — via the "Custom" option — a full model ID; same values the CLI's own
 * --model flag accepts; "Default" clears it back to "let the CLI decide")
 * and, if confirmed with a real change, PATCHes it. The PATCH route evicts
 * the agent's running process when this actually changes (baked into spawn
 * args like workingDir/resumeId) so the NEXT message respawns with --model
 * plus --resume — a genuine mid-conversation switch, not a fresh session
 * (confirmed against the real CLI: same session_id, same history, just a
 * one-time prompt-cache rebuild on that turn). See modelOverride's docs in
 * server/store/db.js.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function changeAgentModel(agent) {
  const { confirmed, value } = await confirmDialog(
    t('confirm.switchModel', { name: agent.name }),
    { modelInput: { value: agent.modelOverride ?? '', provider: agent.provider, workingDir: agent.workingDir }, okLabel: t('confirm.switchModelBtn') },
  );
  if (!confirmed) return;
  const modelOverride = value.trim();
  if (modelOverride === (agent.modelOverride ?? '')) return;

  const res = await fetch(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelOverride }),
  });
  if (res.ok) {
    const updated = /** @type {Agent} */ (await res.json());
    const idx = agents.findIndex((a) => a.id === agent.id);
    if (idx !== -1) agents[idx] = updated;
  }
  renderAgentPanel();
}

/**
 * Prompts for this agent's own context-compaction window ("auto", or
 * 100k–1M tokens; empty goes back to the Settings default) and, if it
 * changed, PATCHes it. Can change at any point in the agent's life: the
 * PATCH route restarts its process once any turn in progress finishes, and
 * the next turn resumes the same session with the new window. See
 * autocompactOverride's docs in server/store/db.js.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function changeAgentAutocompact(agent) {
  const { confirmed, value } = await confirmDialog(
    t('confirm.changeAutocompact', { name: agent.name, value: effectiveDefaultAutocompact() }),
    {
      textInput: { value: agent.autocompactOverride ?? '', placeholder: t('confirm.autocompactPlaceholder', { value: effectiveDefaultAutocompact() }), list: 'autocompact-presets' },
      okLabel: t('confirm.changeAutocompactBtn'),
    },
  );
  if (!confirmed) return;
  const autocompactOverride = value.trim();
  if (autocompactOverride === (agent.autocompactOverride ?? '')) return;

  const res = await fetch(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autocompactOverride }),
  });
  if (res.ok) {
    const updated = /** @type {Agent} */ (await res.json());
    const idx = agents.findIndex((a) => a.id === agent.id);
    if (idx !== -1) agents[idx] = updated;
  } else {
    const body = await res.json().catch(() => ({}));
    showAgentPanelError(body.error ?? t('errors.invalidAutocompact'));
  }
  renderAgentPanel();
}

// ─── Chat actions ────────────────────────────────────────────────────────────

/** sessionStorage key for the last-active chat — per-tab fallback for
 * restoring the chat view on a bare "/" visit (no ?chat= in the URL), e.g.
 * a stale bookmark from before this existed. The URL (see CHAT_URL_PARAM
 * below) is the primary source of truth now, since it's what makes a chat
 * shareable — sessionStorage only covers the case the URL doesn't. */
const ACTIVE_CHAT_STORAGE_KEY = 'app.activeChatId';

/** Query param a chat's id is mirrored into (?chat=<id>), so the address bar
 * can be copied and pasted elsewhere (another tab, another Claude instance,
 * a teammate) to reopen this exact chat. See syncChatIdToUrl/getChatIdFromUrl. */
const CHAT_URL_PARAM = 'chat';

/**
 * Reads the ?chat=<id> query param from the current URL, if present.
 * @returns {string | null}
 */
function getChatIdFromUrl() {
  return new URLSearchParams(location.search).get(CHAT_URL_PARAM);
}

/**
 * Mirrors `id` into the ?chat= query param (or removes it, when `id` is
 * null) without a page reload. `push` adds a new browser-history entry so
 * Back/Forward step through chat switches; omit it (the default) to replace
 * the current entry in place instead — used for the initial URL/
 * sessionStorage-driven restore on load and for popstate-triggered
 * switches, neither of which should themselves become a new Back stop.
 * @param {string | null} id
 * @param {{ push?: boolean }} [opts]
 */
function syncChatIdToUrl(id, { push = false } = {}) {
  const url = new URL(location.href);
  if (id) url.searchParams.set(CHAT_URL_PARAM, id);
  else url.searchParams.delete(CHAT_URL_PARAM);
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

/**
 * Clears the chat view back to "no chat selected" — used when deleting the
 * active chat, and when the id restored from the URL/sessionStorage no
 * longer corresponds to a real chat (e.g. it was deleted in another tab).
 */
function showEmptyChatState() {
  activeChatId = null;
  sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
  syncChatIdToUrl(null);
  emptyState.hidden = false;
  chatView.hidden = true;
  pendingScheduledMessages = [];
  renderChatList();
  renderAgentPanel();
}

/**
 * Reflects the active chat's freeRelay setting on #free-relay-btn.
 */
function renderFreeRelayBtn() {
  const on = Boolean(activeChat()?.freeRelay);
  freeRelayBtn.classList.toggle('active', on);
  freeRelayBtn.setAttribute('aria-pressed', String(on));
  freeRelayBtn.title = t(on ? 'chat.freeRelayOnTitle' : 'chat.freeRelayOffTitle');
}

/**
 * Toggles the active chat's freeRelay setting via the REST API and updates
 * the local cache + button in place (mirrors createChat/deleteChat's own
 * simple fetch-then-patch-local-state pattern — no WS broadcast for this,
 * same as agent PATCH edits).
 */
async function toggleFreeRelay() {
  const chat = activeChat();
  if (!chat) return;
  const res = await fetch(`/api/chats/${chat.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ freeRelay: !chat.freeRelay }),
  });
  const updated = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === updated.id);
  if (idx !== -1) chats[idx] = updated;
  renderFreeRelayBtn();
}

/**
 * Reflects the active chat's autoContinue setting on #auto-continue-btn.
 */
function renderAutoContinueBtn() {
  const on = Boolean(activeChat()?.autoContinue);
  autoContinueBtn.classList.toggle('active', on);
  autoContinueBtn.setAttribute('aria-pressed', String(on));
  autoContinueBtn.title = t(on ? 'chat.autoContinueOnTitle' : 'chat.autoContinueOffTitle');
}

/**
 * Toggles the active chat's autoContinue setting via the REST API and
 * updates the local cache + button in place — same fetch-then-patch-local-
 * state pattern as toggleFreeRelay.
 */
async function toggleAutoContinue() {
  const chat = activeChat();
  if (!chat) return;
  const res = await fetch(`/api/chats/${chat.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoContinue: !chat.autoContinue }),
  });
  const updated = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === updated.id);
  if (idx !== -1) chats[idx] = updated;
  renderAutoContinueBtn();
}

/**
 * Switches the active chat, loads its message history, and re-renders.
 * Mirrors the choice into both sessionStorage and the URL's ?chat= param
 * (see ACTIVE_CHAT_STORAGE_KEY/syncChatIdToUrl) so a refresh — or pasting
 * the address bar elsewhere — returns to the same chat instead of always
 * landing back on "no chat selected".
 * @param {string} id
 * @param {{ push?: boolean }} [opts] - Forwarded to syncChatIdToUrl; pass
 *   `{ push: true }` for a user-driven switch (sidebar click, new chat) so
 *   Back/Forward can step through it. Omit for a programmatic restore
 *   (initial load, popstate) that shouldn't itself add a history entry.
 */
async function selectChat(id, opts = {}) {
  activeChatId = id;
  sessionStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, id);
  syncChatIdToUrl(id, opts);
  unreadChatIds.delete(id);
  messageFilterAgentIds.clear();
  unseenOutsideFocusAgentIds.clear();
  renderMessageFilterBar();
  closeSearchBar();
  isViewingSearchContext = false;
  jumpedBanner.hidden = true;
  staleAutoContinueBanner.hidden = true;
  pageNav.hidden = true;
  renderChatList();
  renderAgentPanel();
  // On a narrow viewport the chat list a user just picked from is an
  // off-canvas drawer (see the responsive drawers section) — closing it
  // automatically here matches how any mobile chat app behaves, and is a
  // harmless no-op on a wide viewport where it was never open.
  closeDrawer();

  const chat = activeChat();
  chatTopbarName.textContent = t('chat.channelName', { name: chat?.name ?? '' });
  renderFreeRelayBtn();
  renderAutoContinueBtn();
  emptyState.hidden = true;
  chatView.hidden = false;

  // Streaming bubbles for the chat we're leaving are about to be wiped out
  // by the innerHTML reset below — detach their DOM wiring first so the
  // underlying streamingEntries survive (data intact) for the
  // reconciliation pass below to rebuild them if/when the user switches
  // back in while still streaming.
  for (const entry of Object.values(streamingEntries)) {
    if (entry.el) detachStreamingBubble(entry);
  }
  messageList.innerHTML = '';
  renderTypingBar();

  // Lands on the latest page and (since that's always where 'last' lands)
  // reattaches any stream still running in this chat — e.g. the user asked
  // something, switched away before/while the agent replied, and has now
  // switched back. Without this, a stream still going while this chat
  // wasn't active would never show as in-progress, and its finished reply
  // would silently never render (see onStreamEnd).
  await loadMessagesPage(id, 'last');

  scheduledPanel.hidden = true;
  const scheduledRes = await fetch(`/api/chats/${id}/scheduled-messages`);
  pendingScheduledMessages = /** @type {ScheduledMessage[]} */ (await scheduledRes.json());
  renderScheduledPanel();
}

/**
 * Creates a new chat via the REST API and selects it.
 * @param {string} name
 */
async function createChat(name) {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const chat = /** @type {Chat} */ (await res.json());
  chats.push(chat);
  renderChatList();
  await selectChat(chat.id, { push: true });
}

/**
 * Deletes a chat via the REST API. When `deleteAgents` is true, also
 * permanently deletes every agent that was a member of this chat — safe to
 * do unconditionally since an agent belongs to at most one chat at a time,
 * so none of them can be a member of some *other* chat we'd be pulling the
 * rug out from under.
 * @param {string} id
 * @param {boolean} [deleteAgents]
 */
async function deleteChat(id, deleteAgents = false) {
  const deletedAgentIds = deleteAgents ? (chats.find((c) => c.id === id)?.memberAgentIds ?? []) : [];
  await fetch(`/api/chats/${id}${deleteAgents ? '?deleteAgents=true' : ''}`, { method: 'DELETE' });
  chats = chats.filter((c) => c.id !== id);
  unreadChatIds.delete(id);
  if (deletedAgentIds.length > 0) {
    agents = agents.filter((a) => !deletedAgentIds.includes(a.id));
  }
  if (activeChatId === id) {
    showEmptyChatState();
  }
  renderChatList();
  if (deletedAgentIds.length > 0) renderAgentPanel();
}

// ─── Member actions ───────────────────────────────────────────────────────────

/**
 * Shows a short-lived error message under the agent panel's add-agent
 * control (e.g. a rejected cross-chat add). Mirrors showAttachmentError.
 * @param {string} text
 */
function showAgentPanelError(text) {
  agentPanelError.textContent = text;
  agentPanelError.hidden = false;
  setTimeout(() => { agentPanelError.hidden = true; }, 4000);
}

/**
 * Adds an agent to the active chat.
 * @param {string} agentId
 */
async function addMember(agentId) {
  const res = await fetch(`/api/chats/${activeChatId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  addAgentMenu.hidden = true;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The add-menu's candidate list is only as fresh as our local `chats`
    // state — a rejection can mean another tab just claimed this agent, so
    // resync before re-rendering rather than leaving a stale, still-offered
    // entry in the menu. renderAgentPanel() resets the error banner, so
    // show the error AFTER re-rendering, not before.
    chats = await (await fetch('/api/chats')).json();
    renderAgentPanel();
    showAgentPanelError(body.error ?? t('errors.addMemberFailed'));
    return;
  }
  const chat = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx !== -1) chats[idx] = chat;
  renderAgentPanel();
}

/**
 * Removes an agent from the active chat.
 * @param {string} agentId
 */
async function removeMember(agentId) {
  const res = await fetch(`/api/chats/${activeChatId}/members/${agentId}`, { method: 'DELETE' });
  const chat = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx !== -1) chats[idx] = chat;
  renderAgentPanel();
}

/**
 * Permanently deletes an agent from the system (not just from the current chat).
 * @param {string} agentId
 */
async function deleteGlobalAgent(agentId) {
  await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
  agents = agents.filter((a) => a.id !== agentId);
  // Remove from all chats in local state
  for (const chat of chats) {
    chat.memberAgentIds = chat.memberAgentIds.filter((id) => id !== agentId);
  }
  renderAgentPanel();
}

// ─── Scheduled messages ───────────────────────────────────────────────────────

/**
 * Re-renders the topbar badge (with a count) and its dropdown panel from
 * pendingScheduledMessages. The badge itself is hidden entirely when
 * there's nothing pending, same convention as addAgentBtn's own
 * available-candidates check.
 */
function renderScheduledPanel() {
  renderStaleAutoContinueBanner();

  scheduledBtn.hidden = !activeChatId || pendingScheduledMessages.length === 0;
  scheduledBtn.textContent = `🕐 ${pendingScheduledMessages.length}`;
  scheduledBtn.title = t('schedule.panelTitle');

  scheduledPanel.innerHTML = '';
  if (pendingScheduledMessages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'scheduled-item-empty';
    empty.textContent = t('schedule.panelEmpty');
    scheduledPanel.appendChild(empty);
    return;
  }
  for (const scheduled of pendingScheduledMessages) {
    const li = document.createElement('li');
    li.className = 'scheduled-item';
    li.dataset.testid = 'scheduled-item';
    li.dataset.scheduledId = scheduled.id;
    li.innerHTML = `
      <div class="scheduled-item-content">
        <span class="scheduled-item-preview" data-testid="scheduled-item-preview">${escHtml(scheduled.content || t('attachments.defaultPastedTextLabel'))}</span>
        <span class="scheduled-item-time" data-testid="scheduled-item-time">${fmtScheduledTime(scheduled.sendAt)}</span>
      </div>
      <button class="scheduled-edit-btn" data-testid="scheduled-edit-btn" title="${t('schedule.editTitle')}">✎</button>
      <button class="scheduled-cancel-btn" data-testid="scheduled-cancel-btn" title="${t('schedule.cancelTitle')}">✕</button>`;
    li.querySelector('.scheduled-edit-btn').addEventListener('click', () => openScheduleModalForEdit(scheduled));
    li.querySelector('.scheduled-cancel-btn').addEventListener('click', () => cancelScheduled(scheduled.id));
    scheduledPanel.appendChild(li);
  }
}

/**
 * Cancels a pending scheduled message via the REST API and updates local state.
 * @param {string} id
 */
async function cancelScheduled(id) {
  await fetch(`/api/chats/${activeChatId}/scheduled-messages/${id}`, { method: 'DELETE' });
  pendingScheduledMessages = pendingScheduledMessages.filter((m) => m.id !== id);
  renderScheduledPanel();
}

/**
 * Renders the inline banner for a scheduled message that's stuck: an
 * auto-continue "please continue" nudge (ScheduledMessage.isAutoContinue)
 * whose sendAt has already passed. initScheduler (services/scheduler.js)
 * leaves these un-armed after a restart instead of firing them
 * automatically — a session-limit reset time assumed stale after downtime
 * shouldn't just fire on its own — so the user gets to decide, right here,
 * whether it still makes sense to send. Hidden entirely when there's
 * nothing stuck, same convention as the scheduled panel's own badge.
 */
function renderStaleAutoContinueBanner() {
  const now = Date.now();
  const stale = pendingScheduledMessages.filter(
    (m) => m.isAutoContinue && new Date(m.sendAt).getTime() <= now
  );
  staleAutoContinueBanner.innerHTML = '';
  staleAutoContinueBanner.hidden = stale.length === 0;
  for (const scheduled of stale) {
    const li = document.createElement('li');
    li.className = 'stale-auto-continue-item';
    li.dataset.testid = 'stale-auto-continue-item';
    li.dataset.scheduledId = scheduled.id;
    li.innerHTML = `
      <div class="stale-auto-continue-text">
        <span class="stale-auto-continue-preview" data-testid="stale-auto-continue-preview">${escHtml(scheduled.content || t('attachments.defaultPastedTextLabel'))}</span>
        <span class="stale-auto-continue-note" data-testid="stale-auto-continue-note">${t('schedule.staleAutoContinueNote', { time: fmtScheduledTime(scheduled.sendAt) })}</span>
      </div>
      <div class="stale-auto-continue-actions">
        <button class="stale-auto-continue-fire-btn" data-testid="stale-auto-continue-fire-btn">${t('schedule.fireNowBtn')}</button>
        <button class="stale-auto-continue-discard-btn" data-testid="stale-auto-continue-discard-btn">${t('schedule.discardBtn')}</button>
      </div>`;
    li.querySelector('.stale-auto-continue-fire-btn').addEventListener('click', () => fireScheduledNow(scheduled.id));
    li.querySelector('.stale-auto-continue-discard-btn').addEventListener('click', () => cancelScheduled(scheduled.id));
    staleAutoContinueBanner.appendChild(li);
  }
}

/**
 * Fires a stuck scheduled message right now via the fire-now REST route,
 * instead of waiting for a timer that initScheduler deliberately never
 * armed for it (see renderStaleAutoContinueBanner's docs). Used by that
 * banner's "Continue now" button. The resulting agent reply arrives the
 * normal way via AGENT_STREAM_* events; the SCHEDULED_MESSAGE_FIRED
 * broadcast this triggers (see onScheduledMessageFired) would also remove
 * it from pendingScheduledMessages, but this does so eagerly so the banner
 * doesn't wait on that round-trip.
 * @param {string} id
 */
async function fireScheduledNow(id) {
  await fetch(`/api/chats/${activeChatId}/scheduled-messages/${id}/fire-now`, { method: 'POST' });
  pendingScheduledMessages = pendingScheduledMessages.filter((m) => m.id !== id);
  renderScheduledPanel();
}

// ─── Quick messages ─────────────────────────────────────────────────────────

/**
 * Re-renders the ⚡ panel from `quickMessages` — same list/edit/delete-row
 * shape as renderScheduledPanel, plus a trailing "+ Add" row. Unlike
 * scheduled messages, the button itself is never hidden (an empty list
 * still needs a way to add the first one).
 */
function renderQuickMsgPanel() {
  quickMsgPanel.innerHTML = '';
  if (quickMessages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'quick-msg-item-empty';
    empty.textContent = t('quickMsg.panelEmpty');
    quickMsgPanel.appendChild(empty);
  }
  quickMessages.forEach((qm, i) => {
    const li = document.createElement('li');
    li.className = 'quick-msg-item';
    li.dataset.testid = 'quick-msg-item';
    li.dataset.quickMsgId = qm.id;
    const hotkey = i < 9 ? `<span class="quick-msg-hotkey">Alt+${i + 1}</span>` : '';
    li.innerHTML = `
      ${hotkey}
      <button class="quick-msg-item-text" data-testid="quick-msg-item-text" title="${escHtml(qm.text)}">${escHtml(qm.text)}</button>
      <button class="quick-msg-edit-btn" data-testid="quick-msg-edit-btn" title="${t('quickMsg.editTitle')}">✎</button>
      <button class="quick-msg-del-btn" data-testid="quick-msg-del-btn" title="${t('quickMsg.deleteTitle')}">✕</button>`;
    li.querySelector('.quick-msg-item-text').addEventListener('click', () => useQuickMessage(qm.text));
    li.querySelector('.quick-msg-edit-btn').addEventListener('click', (e) => { e.stopPropagation(); editQuickMessage(qm); });
    li.querySelector('.quick-msg-del-btn').addEventListener('click', (e) => { e.stopPropagation(); removeQuickMessage(qm.id); });
    quickMsgPanel.appendChild(li);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'quick-msg-add-btn';
  addBtn.dataset.testid = 'quick-msg-add-btn';
  addBtn.textContent = `+ ${t('quickMsg.addBtn')}`;
  addBtn.addEventListener('click', addQuickMessage);
  quickMsgPanel.appendChild(addBtn);
}

/**
 * Inserts a quick message's text at the composer's current cursor position
 * (same insert-not-replace behavior as quickMention, so e.g. an already-typed
 * "@Name " prefix is kept rather than clobbered) and focuses it — deliberately
 * NOT auto-sent, so there's always a chance to glance at it, add an
 * attachment, or tweak a word before hitting send.
 * @param {string} text
 */
function useQuickMessage(text) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const insertion = (needsLeadingSpace ? ' ' : '') + text;
  msgInput.value = before + insertion + msgInput.value.slice(cursor);
  const newCursor = before.length + insertion.length;
  quickMsgPanel.hidden = true;
  msgInput.focus();
  msgInput.setSelectionRange(newCursor, newCursor);
  // Auto-resize, same as the textarea's own 'input' handler — setting
  // .value programmatically doesn't fire 'input', and a saved quick message
  // can easily be longer than whatever was already in the box.
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
}

/**
 * Prompts for the text of a brand new quick message and, if confirmed with
 * non-empty content, POSTs it and appends it to local state.
 * @returns {Promise<void>}
 */
async function addQuickMessage() {
  const { confirmed, value } = await confirmDialog(
    t('quickMsg.addPrompt'),
    { textInput: { placeholder: t('quickMsg.textPlaceholder') }, okLabel: t('quickMsg.addBtn') },
  );
  const text = value.trim();
  if (!confirmed || !text) return;
  const res = await fetch('/api/quick-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.ok) {
    quickMessages.push(await res.json());
    renderQuickMsgPanel();
  }
}

/**
 * Prompts for new text for an existing quick message and, if confirmed with
 * a real change, PATCHes it.
 * @param {QuickMessage} qm
 * @returns {Promise<void>}
 */
async function editQuickMessage(qm) {
  const { confirmed, value } = await confirmDialog(
    t('quickMsg.editPrompt'),
    { textInput: { value: qm.text }, okLabel: t('quickMsg.saveBtn') },
  );
  const text = value.trim();
  if (!confirmed || !text || text === qm.text) return;
  const res = await fetch(`/api/quick-messages/${qm.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (res.ok) {
    const updated = await res.json();
    const idx = quickMessages.findIndex((m) => m.id === qm.id);
    if (idx !== -1) quickMessages[idx] = updated;
    renderQuickMsgPanel();
  }
}

/**
 * Deletes a quick message via the REST API and updates local state. No
 * confirmation step — unlike deleting an agent or chat, this is a short
 * saved snippet with no downstream consequence, trivially re-added if it
 * turns out to still be wanted.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function removeQuickMessage(id) {
  await fetch(`/api/quick-messages/${id}`, { method: 'DELETE' });
  quickMessages = quickMessages.filter((m) => m.id !== id);
  renderQuickMsgPanel();
}

/**
 * Re-renders the schedule modal's own attachment chip row from
 * scheduleModalAttachments — a separate copy from the composer's
 * pendingAttachments (see that field's docs), so removing a chip here never
 * touches whatever's independently pending in the composer.
 */
function renderScheduleAttachmentChips() {
  renderAttachmentChipsInto(scheduleAttachmentChips, scheduleModalAttachments, (id) => {
    scheduleModalAttachments = scheduleModalAttachments.filter((a) => a.id !== id);
    renderScheduleAttachmentChips();
  });
}

/**
 * Shared tail of opening the schedule modal for either a brand new message
 * or editing a pending one — everything both cases need after their
 * distinct fields (title/submit label, content, attachments, time) are
 * already set.
 */
function showScheduleModal() {
  scheduleError.hidden = true;
  scheduleError.textContent = '';
  scheduleSubmit.disabled = false;
  renderScheduleAttachmentChips();
  // Best-effort min (browser support for `min` on datetime-local varies) —
  // the submit handler re-validates regardless.
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  scheduleTimeInput.min = now.toISOString().slice(0, 16);
  scheduledPanel.hidden = true;
  scheduleOverlay.hidden = false;
  scheduleContentInput.focus();
}

/**
 * Opens the schedule modal to compose a NEW scheduled message, seeded from
 * whatever's currently in the main composer (content + attachments) —
 * same starting point as the old behavior, but from here on the modal owns
 * its own editable copy of both. That's what fixes the old trap where
 * clicking Schedule on an empty composer only surfaced a "content
 * required" error after picking a time, with no field in the modal itself
 * to fix it from: now there's always a visible, directly-editable content
 * field right there.
 */
function openScheduleModal() {
  editingScheduledId = null;
  scheduleTitleEl.textContent = t('schedule.modalTitle');
  scheduleSubmit.textContent = t('schedule.submitBtn');
  scheduleContentInput.value = msgInput.value;
  scheduleModalAttachments = [...pendingAttachments];
  scheduleTimeInput.value = '';
  showScheduleModal();
}

/**
 * Opens the schedule modal to modify a pending scheduled message already
 * on the server — same modal and validation as creating one, but the
 * submit handler PATCHes the existing row (re-arming its timer) instead of
 * POSTing a new one, and leaves the main composer untouched since none of
 * this content ever came from it.
 * @param {ScheduledMessage} scheduled
 */
function openScheduleModalForEdit(scheduled) {
  editingScheduledId = scheduled.id;
  scheduleTitleEl.textContent = t('schedule.modalTitleEdit');
  scheduleSubmit.textContent = t('schedule.saveBtn');
  scheduleContentInput.value = scheduled.content;
  scheduleModalAttachments = [...scheduled.attachments];
  scheduleTimeInput.value = toDatetimeLocalValue(scheduled.sendAt);
  showScheduleModal();
}

function closeScheduleModal() {
  scheduleOverlay.hidden = true;
  editingScheduledId = null;
}

/**
 * Submits the schedule form: creates a new scheduled message (clearing the
 * composer afterward, exactly like a normal send) or, when the modal was
 * opened via openScheduleModalForEdit, PATCHes the existing one in place
 * instead. @mention targeting is resolved fresh once the message actually
 * fires either way, same as a live message — nothing about targeting is
 * decided here.
 * @param {SubmitEvent} e
 */
async function handleScheduleFormSubmit(e) {
  e.preventDefault();
  const content = scheduleContentInput.value.trim();
  if (!content && scheduleModalAttachments.length === 0) {
    scheduleError.textContent = t('errors.scheduledContentRequired');
    scheduleError.hidden = false;
    return;
  }
  const sendAtMs = new Date(scheduleTimeInput.value).getTime();
  if (!scheduleTimeInput.value || Number.isNaN(sendAtMs) || sendAtMs <= Date.now()) {
    scheduleError.textContent = t('schedule.pastTimeError');
    scheduleError.hidden = false;
    return;
  }

  const isEdit = editingScheduledId !== null;
  scheduleSubmit.disabled = true;
  scheduleError.hidden = true;
  try {
    const url = isEdit
      ? `/api/chats/${activeChatId}/scheduled-messages/${editingScheduledId}`
      : `/api/chats/${activeChatId}/scheduled-messages`;
    const res = await fetch(url, {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachments: scheduleModalAttachments, sendAt: new Date(sendAtMs).toISOString() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      scheduleError.textContent = body.error ?? t('errors.scheduledContentRequired');
      scheduleError.hidden = false;
      return;
    }
    const scheduled = /** @type {ScheduledMessage} */ (await res.json());
    if (isEdit) {
      pendingScheduledMessages = pendingScheduledMessages.map((m) => (m.id === scheduled.id ? scheduled : m));
    } else {
      pendingScheduledMessages.push(scheduled);
      clearComposer();
    }
    pendingScheduledMessages.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
    renderScheduledPanel();
    closeScheduleModal();
  } finally {
    scheduleSubmit.disabled = false;
  }
}

// ─── Create agent modal ───────────────────────────────────────────────────────

function openModal() {
  agentNameInput.value = '';
  agentDirInput.value = '';
  agentResumeInput.value = '';
  providerAvailability = new Map();
  agentProviderSelect.value = DEFAULT_PROVIDER_ID;
  renderProviderOptions();
  applyProviderToAgentForm();
  refreshProviderAvailability();
  agentAutocompactInput.value = '';
  agentAutocompactInput.placeholder = t('agentModal.autocompactPlaceholder', { value: effectiveDefaultAutocompact() });
  agentNoteInput.value = '';
  yoloModeCheck.checked = false;
  observerModeCheck.checked = false;
  chromeAccessCheck.checked = false;
  agentError.hidden = true;
  agentError.textContent = '';
  modalSubmit.disabled = false;
  addToChatLabel.hidden = !activeChatId;
  addToChatCheck.checked = !!activeChatId;
  selectedColor = PRESET_COLORS[0];
  renderColorGrid(colorGrid, selectedColor, (c) => { selectedColor = c; });
  renderRecentDirs();
  modalOverlay.hidden = false;
  agentNameInput.focus();
}

/**
 * What GET /api/providers last said about each provider for the New Agent
 * form's working directory, by provider id. Empty while the first check is
 * in flight, when every provider is offered.
 * @type {Map<string, { id: string, available: boolean, source: string, version?: string, error?: string }>}
 */
let providerAvailability = new Map();

/** Bumped per check, so a slow answer for an older working directory is ignored. */
let providerCheckSeq = 0;

/**
 * Asks the server which providers can run for the working directory
 * currently in the New Agent form (a project can pin its own opencode), and
 * re-renders the provider picker from the answer. A failed check leaves
 * every provider offered: Create runs the same check anyway.
 * @returns {Promise<void>}
 */
async function refreshProviderAvailability() {
  const seq = ++providerCheckSeq;
  const workingDir = agentDirInput.value.trim();
  if (!providerAvailability.size) agentProviderStatus.textContent = t('agentModal.providerChecking');
  try {
    const res = await fetch(`/api/providers${workingDir ? `?workingDir=${encodeURIComponent(workingDir)}` : ''}`);
    if (!res.ok || seq !== providerCheckSeq) return;
    providerAvailability = new Map((await res.json()).map((result) => [result.id, result]));
  } catch {
    if (seq !== providerCheckSeq) return;
    providerAvailability = new Map();
  }
  renderProviderOptions();
  refreshAgentModelOptions();
}

/**
 * Renders the provider picker: every provider, with one the server couldn't
 * find disabled and marked as such. If that's the one picked, the picker
 * moves to the first one that can run, since Create would only fail.
 * @returns {void}
 */
function renderProviderOptions() {
  const picked = agentProviderSelect.value || DEFAULT_PROVIDER_ID;
  agentProviderSelect.innerHTML = PROVIDER_IDS.map((id) => {
    const { label } = providerDisplayFor(id);
    const missing = providerAvailability.get(id)?.available === false;
    return `<option value="${id}"${missing ? ' disabled' : ''}>${escHtml(missing ? t('agentModal.providerNotFoundOption', { provider: label }) : label)}</option>`;
  }).join('');
  const runnable = (id) => providerAvailability.get(id)?.available !== false;
  const next = runnable(picked) ? picked : PROVIDER_IDS.find(runnable);
  agentProviderSelect.value = next ?? picked;
  if (next && next !== picked) applyProviderToAgentForm();
  renderProviderStatus();
}

/**
 * The line under the provider picker: which binary the picked provider will
 * run and where it was found, and how to install any provider that wasn't.
 * @returns {void}
 */
function renderProviderStatus() {
  if (!providerAvailability.size) return;
  const lines = [];
  const picked = providerAvailability.get(agentProviderSelect.value);
  if (picked?.available) {
    lines.push(t('agentModal.providerFound', {
      provider: providerDisplayFor(picked.id).label,
      version: picked.version ?? '',
      source: t(`agentModal.providerSource.${picked.source}`),
    }).replace(/\s+/g, ' '));
  }
  for (const result of providerAvailability.values()) {
    if (!result.available) lines.push(t(`provider.${result.id}.notFound`));
  }
  agentProviderStatus.textContent = lines.join(' ');
  modalSubmit.disabled = picked?.available === false;
}

/**
 * Fits the New Agent form to the provider picked in it: its own model
 * picker, resume command and default names, and only the options that
 * apply to it (see ProviderDisplay in agentProviders.js). A generated name
 * from another provider's pool is swapped for one of this provider's,
 * since a name hints at what the agent runs as.
 * @returns {void}
 */
function applyProviderToAgentForm() {
  const display = providerDisplayFor(agentProviderSelect.value);
  setModelSelectValue(agentModelInput, agentModelCustomInput, '', display);
  agentModelHint.textContent = t(display.modelAliases ? 'agentModal.modelHint' : 'agentModal.modelIdHint');
  refreshAgentModelOptions();
  agentResumeHint.innerHTML = t('agentModal.resumeIdHint', { command: escHtml(display.resumeCommand('').trim()) });
  agentAutocompactLabel.hidden = !display.autocompact;
  if (!display.autocompact) agentAutocompactInput.value = '';
  chromeAccessLabel.hidden = !display.chromeAccess;
  if (!display.chromeAccess) chromeAccessCheck.checked = false;
  const generatedElsewhere = PROVIDER_IDS.some((id) => id !== display.id && providerDisplayFor(id).namePool.includes(agentNameInput.value));
  if (generatedElsewhere) agentNameInput.value = generateAgentName(display.id);
  renderProviderStatus();
}

/** Bumped per model listing, so a slow answer for an older provider or directory is ignored. */
let agentModelsSeq = 0;

/**
 * Offers the models the New Agent form's provider lists for its working
 * directory (see fetchProviderModels), keeping whatever model is already
 * picked or typed. Nothing changes for a provider with aliases of its own.
 * @returns {Promise<void>}
 */
async function refreshAgentModelOptions() {
  const seq = ++agentModelsSeq;
  const display = providerDisplayFor(agentProviderSelect.value);
  if (display.modelAliases) return;
  const models = await fetchProviderModels(display.id, agentDirInput.value.trim());
  if (seq !== agentModelsSeq || modalOverlay.hidden) return;
  const current = getModelSelectValue(agentModelInput, agentModelCustomInput);
  setModelSelectValue(agentModelInput, agentModelCustomInput, current, display, models);
  agentModelHint.textContent = t(models.length ? 'agentModal.modelListHint' : 'agentModal.modelIdHint');
}

/** Most working directories to offer as one-click picks in the New Agent modal. */
const MAX_RECENT_DIRS = 6;

/**
 * Renders one-click chips for working directories already used by existing
 * agents, so adding a second/third agent to the same project doesn't require
 * clicking all the way through the folder browser again. Deduped by
 * directory, most-recently-created agent's use of a dir wins its position —
 * a reasonable proxy for "recently used" without tracking actual last-use
 * separately. Hidden entirely once there's nothing to offer (fresh install).
 */
function renderRecentDirs() {
  const seen = new Set();
  const dirs = [];
  for (const agent of [...agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (seen.has(agent.workingDir)) continue;
    seen.add(agent.workingDir);
    dirs.push(agent.workingDir);
    if (dirs.length >= MAX_RECENT_DIRS) break;
  }

  agentDirRecent.innerHTML = '';
  agentDirRecentWrap.hidden = dirs.length === 0;
  for (const dir of dirs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = dir;
    chip.textContent = shortDir(dir);
    chip.addEventListener('click', () => { agentDirInput.value = dir; refreshProviderAvailability(); });
    agentDirRecent.appendChild(chip);
  }
}

function closeModal() {
  modalOverlay.hidden = true;
}

/**
 * Renders a row of PRESET_COLORS swatches into a container, highlighting the
 * currently selected one and calling onSelect when a different one is
 * clicked. Shared by the New Agent modal's color picker and the settings
 * modal's message-color picker.
 * @param {HTMLElement} container
 * @param {string} selected
 * @param {(color: string) => void} onSelect
 */
function renderColorGrid(container, selected, onSelect) {
  container.innerHTML = '';
  for (const c of PRESET_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch' + (c === selected ? ' selected' : '');
    btn.style.background = c;
    btn.title = c;
    btn.addEventListener('click', () => {
      onSelect(c);
      container.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      btn.classList.add('selected');
    });
    container.appendChild(btn);
  }
}

/**
 * Picks a default name for a new agent from its provider's pool (see
 * agentProviders.js), avoiding collisions with every existing agent's name.
 * Defaults to the provider picked in the New Agent form.
 * @param {string} [providerId]
 * @returns {string}
 */
function generateAgentName(providerId = agentProviderSelect.value || DEFAULT_PROVIDER_ID) {
  return nameGeneratorFor(providerId)(agents.map((a) => a.name));
}

// ─── Settings modal ─────────────────────────────────────────────────────────

/**
 * Opens the settings modal, pre-filled with the current display name.
 * @returns {Promise<void>}
 */
async function openSettingsModal() {
  settingsError.hidden = true;
  settingsError.textContent = '';
  settingsSave.disabled = false;
  // Shown only once every field below is populated — showing it first and
  // filling fields in after the fetch resolves left a window where the
  // modal was visible but still stale, and a selection made in that window
  // (e.g. picking a new language right after opening) got silently
  // clobbered the moment the fetch finally landed and overwrote it back.
  try {
    const res = await fetch('/api/settings');
    const settings = /** @type {Settings} */ (await res.json());
    settingsDisplayNameInput.value = settings.userDisplayName;
    selectedUserColor = settings.userColor;
    settingsLanguageSelect.value = settings.locale;
    settingsThemeSelect.value = settings.theme;
    settingsAutocompactInput.value = settings.defaultAutocompact;
    settingsAutocompactInput.placeholder = t('settingsModal.autocompactPlaceholder', { value: settings.autocompactFallback });
  } catch {
    settingsDisplayNameInput.value = '';
    selectedUserColor = userSettings.userColor;
    settingsLanguageSelect.value = currentLocale;
    settingsThemeSelect.value = userSettings.theme ?? 'dark';
    settingsAutocompactInput.value = userSettings.defaultAutocompact ?? '';
    settingsAutocompactInput.placeholder = t('settingsModal.autocompactPlaceholder', { value: userSettings.autocompactFallback });
  }
  renderColorGrid(settingsColorGrid, selectedUserColor, (c) => { selectedUserColor = c; });
  settingsOverlay.hidden = false;
  settingsDisplayNameInput.focus();
}

function closeSettingsModal() {
  settingsOverlay.hidden = true;
}

/**
 * Submits the settings form to the REST API.
 * @param {SubmitEvent} e
 */
async function handleSettingsFormSubmit(e) {
  e.preventDefault();
  const userDisplayName = settingsDisplayNameInput.value.trim();
  if (!userDisplayName) return;
  const userColor = selectedUserColor;
  const locale = settingsLanguageSelect.value;
  const theme = settingsThemeSelect.value;
  const defaultAutocompact = settingsAutocompactInput.value.trim();

  settingsSave.disabled = true;
  settingsError.hidden = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName, userColor, locale, theme, defaultAutocompact }),
    });
    if (!res.ok) {
      const body = await res.json();
      settingsError.textContent = body.error ?? t('errors.saveSettingsFailed');
      settingsError.hidden = false;
      return;
    }
    userSettings = /** @type {Settings} */ (await res.json());
    applyTheme(theme);
    // All four fields apply to the user's whole history/whole UI, not just
    // going forward (the server resolves authorName for user rows live, not
    // from a per-message snapshot; color was never stored per-message; and
    // locale purely controls how the CURRENTLY-RENDERING client displays
    // strings) — reflect that immediately rather than waiting for the next
    // chat switch/reload to re-fetch/re-render.
    document.querySelectorAll('[data-testid="message"][data-role="user"]').forEach((el) => {
      el.querySelector('[data-testid="msg-author"]').textContent = userDisplayName;
    });
    // A theme switch moves what counts as "enough contrast" (see
    // agentDisplayColor), so this has to re-color EVERY already-rendered
    // message/streaming bubble, not just the user's own — an agent's avatar
    // picked when dark theme was active would otherwise stay stuck showing
    // its dark-theme-safe color even after switching to light, until the
    // next reload rebuilds the message list from scratch.
    refreshAgentDisplayColors();
    if (locale !== currentLocale) {
      currentLocale = locale;
      applyTranslations();
      renderChatList();
      document.querySelectorAll('.msg-time[data-iso]').forEach((el) => { el.textContent = fmtTime(el.dataset.iso); });
    }
    renderAgentPanel();
    closeSettingsModal();
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  } finally {
    settingsSave.disabled = false;
  }
}

// ─── Folder browser ─────────────────────────────────────────────────────────

/** @type {string | null} the directory currently listed in the browser */
let browseCurrentPath = null;

/**
 * Monotonically increasing token identifying the most recently issued
 * loadBrowseDir() call. Since a user can trigger a new navigation (typing a
 * path, clicking an entry) before an in-flight fetch resolves, requests can
 * settle out of order — this discards any response that isn't the latest.
 */
let browseRequestId = 0;

/**
 * @typedef {Object} BrowseEntry
 * @property {string} name
 * @property {string} path
 */

/**
 * @typedef {Object} BrowseResult
 * @property {string} path
 * @property {string|null} parent
 * @property {BrowseEntry[]} entries
 */

/**
 * Opens the folder browser, starting from the current Working Directory
 * field's value if set, otherwise the server's default (the user's home dir).
 * @returns {Promise<void>}
 */
async function openFolderBrowser() {
  browseOverlay.hidden = false;
  await loadBrowseDir(agentDirInput.value.trim() || null);
}

/**
 * Closes the folder browser without changing the Working Directory field.
 */
function closeFolderBrowser() {
  browseOverlay.hidden = true;
}

/**
 * Fetches and renders the listing for a directory.
 * @param {string | null} path - Absolute path, or null for the server default
 * @returns {Promise<void>}
 */
async function loadBrowseDir(path) {
  const requestId = ++browseRequestId;
  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
  try {
    const res = await fetch(url);
    const body = /** @type {BrowseResult | { error: string }} */ (await res.json());
    if (requestId !== browseRequestId) return; // superseded by a newer navigation

    if (!res.ok) {
      browseError.textContent = /** @type {{ error: string }} */ (body).error ?? t('errors.readDirectoryFailed');
      browseError.hidden = false;
      return;
    }
    browseError.hidden = true;
    const result = /** @type {BrowseResult} */ (body);
    browseCurrentPath = result.path;
    browsePathInput.value = result.path;
    renderBrowseList(result);
  } catch (err) {
    if (requestId !== browseRequestId) return;
    browseError.textContent = err.message;
    browseError.hidden = false;
  }
}

/**
 * Renders the subdirectory list for the current browse result.
 * @param {BrowseResult} result
 */
function renderBrowseList(result) {
  browseList.innerHTML = '';
  if (result.parent) {
    const up = document.createElement('li');
    up.className = 'browse-item browse-item-up';
    up.textContent = t('browseModal.parentDirLabel');
    up.addEventListener('click', () => loadBrowseDir(result.parent));
    browseList.appendChild(up);
  }
  for (const entry of result.entries) {
    const li = document.createElement('li');
    li.className = 'browse-item';
    li.dataset.testid = 'browse-item';
    li.textContent = entry.name;
    li.addEventListener('click', () => loadBrowseDir(entry.path));
    browseList.appendChild(li);
  }
}

/**
 * Submits the create-agent form to the REST API.
 * @param {SubmitEvent} e
 */
async function handleAgentFormSubmit(e) {
  e.preventDefault();
  const name = agentNameInput.value.trim();
  const workingDir = agentDirInput.value.trim();
  if (!name || !workingDir) return;

  const provider = agentProviderSelect.value;
  const resumeId = agentResumeInput.value.trim() || undefined;
  const modelOverride = getModelSelectValue(agentModelInput, agentModelCustomInput) || undefined;
  const autocompactOverride = agentAutocompactInput.value.trim() || undefined;
  const note = agentNoteInput.value.trim() || undefined;
  const dangerouslySkipPermissions = yoloModeCheck.checked;
  const isObserver = observerModeCheck.checked;
  const chromeAccess = chromeAccessCheck.checked;
  modalSubmit.disabled = true;
  modalSubmit.textContent = t('agentModal.verifyingBtn');
  agentError.hidden = true;

  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: selectedColor, workingDir, provider, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note, modelOverride, autocompactOverride }),
    });
    if (!res.ok) {
      const body = await res.json();
      agentError.textContent = body.error ?? t('errors.createAgentFailed');
      agentError.hidden = false;
      return;
    }
    const agent = /** @type {Agent} */ (await res.json());
    agents.push(agent);

    if (addToChatCheck.checked && activeChatId) {
      await addMember(agent.id);
    } else {
      renderAgentPanel();
    }
    closeModal();
  } catch (err) {
    agentError.textContent = err.message;
    agentError.hidden = false;
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = t('agentModal.createBtn');
  }
}

// ─── @mention / slash-command autocomplete ───────────────────────────────────

/** @type {number} index of focused dropdown item (-1 = none) */
let mentionFocusIdx = -1;

/** @type {Map<string, Promise<import('../services/commands.js').SlashCommand[]>>} */
const agentCommandsCache = new Map();

/**
 * Returns agents in the active chat that match a mention query.
 * @param {string} query
 * @returns {Agent[]}
 */
function getMentionMatches(query) {
  const chat = activeChat();
  if (!chat) return [];
  return agents.filter(
    (a) => chat.memberAgentIds.includes(a.id) && a.name.toLowerCase().startsWith(query.toLowerCase())
  );
}

/**
 * Fetches (and caches for the session) an agent's custom slash commands.
 * @param {string} agentId
 * @returns {Promise<import('../services/commands.js').SlashCommand[]>}
 */
function getAgentCommands(agentId) {
  if (!agentCommandsCache.has(agentId)) {
    agentCommandsCache.set(
      agentId,
      fetch(`/api/agents/${agentId}/commands`).then((r) => (r.ok ? r.json() : [])).catch(() => [])
    );
  }
  return agentCommandsCache.get(agentId);
}

/**
 * Resolves which single agent a slash command typed right now would
 * actually be sent to — matches parseSkillInvocation/parseResponders
 * semantics server-side (server/services/messageRouter.js), so the
 * dropdown never offers a command that wouldn't actually fire: an
 * explicitly @mentioned name, or, unambiguously, the chat's only member.
 * Returns null when it's ambiguous (multiple agents, none addressed) or
 * the addressed name doesn't match a real member.
 * @param {string} [addressedName]
 * @returns {Agent | null}
 */
function resolveSlashCommandAgent(addressedName) {
  const chat = activeChat();
  if (!chat) return null;
  const members = chat.memberAgentIds.map(agentById).filter(Boolean);
  if (addressedName) {
    return members.find((a) => a.name.toLowerCase() === addressedName.toLowerCase()) ?? null;
  }
  return members.length === 1 ? members[0] : null;
}

/**
 * Renders a set of composer-dropdown items (shared by @mention and
 * /command autocomplete — they're mutually exclusive triggers, so only one
 * kind is ever shown at a time) and shows the dropdown, or hides it if
 * there's nothing to offer. Keyboard navigation (ArrowUp/Down/Enter/Escape,
 * wired in the msgInput keydown listener) works generically against any
 * .mention-item element, regardless of which kind it is.
 * @param {{ testId: string, html: string, onSelect: () => void }[]} items
 */
function renderComposerDropdown(items) {
  if (items.length === 0) {
    hideMentionDropdown();
    return;
  }
  mentionFocusIdx = -1;
  mentionDropdown.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'mention-item';
    li.dataset.testid = item.testId;
    li.innerHTML = item.html;
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      item.onSelect();
    });
    mentionDropdown.appendChild(li);
  }
  mentionDropdown.hidden = false;
}

/**
 * Updates the composer's autocomplete dropdown from the current textarea
 * value and cursor — either "/" slash-command or "@" mention, whichever
 * the text up to the cursor matches. A slash command only ever works as
 * the ENTIRE message (optionally preceded by exactly one "@Name "), so
 * unlike @mentions (which can appear anywhere), its trigger is anchored to
 * the very start of the input.
 * @returns {Promise<void>}
 */
async function updateComposerDropdown() {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);

  // [^\s@]+ rather than \w+ — an addressed agent's name, or a command
  // name, can contain a hyphen (or any other non-whitespace character; the
  // agent-creation form has no charset restriction), and \w doesn't
  // include one. With \w+, typing past a hyphen (e.g. "@TP-Observer /")
  // broke the match entirely and silently hid the dropdown for the rest
  // of the name — same root cause as the server-side mention-routing bug.
  const slashMatch = before.match(/^(?:@([^\s@]+)\s+)?\/([^\s@]*)$/);
  if (slashMatch) {
    const [, addressedName, query] = slashMatch;
    const agent = resolveSlashCommandAgent(addressedName);
    if (!agent) {
      hideMentionDropdown();
      return;
    }
    const commands = await getAgentCommands(agent.id);
    const matches = commands.filter((c) => c.name.toLowerCase().startsWith(query.toLowerCase()));
    renderComposerDropdown(matches.map((c) => ({
      testId: 'slash-command-item',
      html: `<span class="mention-avatar slash-icon">/</span>` +
        `<span class="mention-item-main"><span class="mention-item-name">/${escHtml(c.name)}</span>` +
        (c.description ? `<span class="mention-item-desc">${escHtml(c.description)}</span>`
          : c.builtin ? `<span class="mention-item-desc">${t('agent.builtinSkillDesc')}</span>` : '') +
        `</span>`,
      onSelect: () => insertSlashCommand(addressedName ? agent.name : null, c.name),
    })));
    return;
  }

  // Same [^\s@]* reasoning as slashMatch above — a hyphenated in-progress
  // name (e.g. typing "@TP-O...") must keep matching past the hyphen for
  // the dropdown to stay open and keep narrowing as the user types.
  const mentionMatch = before.match(/@([^\s@]*)$/);
  if (mentionMatch) {
    const matches = getMentionMatches(mentionMatch[1]);
    renderComposerDropdown(matches.map((agent) => ({
      testId: 'mention-item',
      html: `<span class="mention-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0]}</span>` +
        `<span class="mention-item-main">` +
        `<span class="mention-item-name" title="${providerTitle(agent)}">${escHtml(agent.name)}${agent.dangerouslySkipPermissions ? ` <span class="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}${agent.chromeAccess ? ` <span class="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}</span>` +
        `<span class="mention-item-desc">${escHtml(shortDir(agent.workingDir))}</span>` +
        (agent.note ? `<span class="mention-item-note">📝 ${escHtml(agent.note)}</span>` : '') +
        `</span>`,
      onSelect: () => insertMention(agent.name),
    })));
    return;
  }

  hideMentionDropdown();
}

function hideMentionDropdown() {
  mentionDropdown.hidden = true;
  mentionFocusIdx = -1;
}

/**
 * Inserts @AgentName at the current cursor position, replacing the @query.
 * @param {string} name
 */
function insertMention(name) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);
  const atIdx = before.lastIndexOf('@');
  msgInput.value = msgInput.value.slice(0, atIdx) + `@${name} ` + msgInput.value.slice(cursor);
  hideMentionDropdown();
  msgInput.focus();
}

/**
 * Appends "@Name " to the composer at the current cursor position and
 * focuses it — the quick "reply to this agent" button next to a message's
 * author name, sparing a trip through typing "@" and picking off the
 * autocomplete dropdown every time you want to address a specific agent in
 * a multi-agent chat. Unlike insertMention (which replaces an in-progress
 * "@query" the user already typed), there's no existing token to replace
 * here, so this inserts cleanly — adding a leading space first if the
 * character right before the cursor isn't already whitespace, so it never
 * runs the new mention into whatever's already typed.
 * @param {string} name
 * @returns {void}
 */
function quickMention(name) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const insertion = (needsLeadingSpace ? ' ' : '') + `@${name} `;
  msgInput.value = before + insertion + msgInput.value.slice(cursor);
  const newCursor = before.length + insertion.length;
  hideMentionDropdown();
  msgInput.focus();
  msgInput.setSelectionRange(newCursor, newCursor);
}

/**
 * Inserts a slash-command selection, replacing everything from the start
 * of the input up to the cursor (a slash command is only ever valid as the
 * entire message) — optionally re-prefixed with "@Name " using the agent's
 * canonical-cased name, if the command was addressed to a specific agent
 * rather than implied by being the chat's only member.
 * @param {string | null} agentName
 * @param {string} commandName
 */
function insertSlashCommand(agentName, commandName) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const prefix = agentName ? `@${agentName} ` : '';
  msgInput.value = `${prefix}/${commandName} ${msgInput.value.slice(cursor)}`;
  hideMentionDropdown();
  msgInput.focus();
}

// ─── Attachments ────────────────────────────────────────────────────────────

/**
 * Shows a short-lived error message under the composer (e.g. cap exceeded).
 * @param {string} text
 */
function showAttachmentError(text) {
  attachmentError.textContent = text;
  attachmentError.hidden = false;
  setTimeout(() => { attachmentError.hidden = true; }, 4000);
}

/**
 * Reads a File/Blob as a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Adds an image file as a pending attachment, enforcing size/count caps.
 * @param {File} file
 * @returns {Promise<void>}
 */
async function addImageAttachment(file) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(t('attachments.maxAttachments', { max: MAX_ATTACHMENTS }));
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showAttachmentError(t('attachments.imageTooLarge', { mb: MAX_IMAGE_BYTES / (1024 * 1024) }));
    return;
  }
  const dataUrl = await readAsDataUrl(file);
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl);
  if (!match) return;
  const [, mediaType, data] = match;
  pendingAttachments.push({
    id: crypto.randomUUID(),
    type: 'image',
    mediaType,
    name: file.name || 'pasted-image',
    data,
    size: file.size,
  });
  renderAttachmentChips();
}

/**
 * Adds a large pasted text block as a pending attachment, enforcing the count cap.
 * @param {string} text
 */
function addTextAttachment(text) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(t('attachments.maxAttachments', { max: MAX_ATTACHMENTS }));
    return;
  }
  pasteTextCounter += 1;
  const lines = text.split('\n').length;
  pendingAttachments.push({
    id: crypto.randomUUID(),
    type: 'text',
    name: t('attachments.pastedText', { count: lines, n: pasteTextCounter, lines }),
    data: text,
    size: text.length,
  });
  renderAttachmentChips();
}

/**
 * Whether a pasted plain-text string is large enough to become an attachment
 * chip instead of being dumped inline into the textarea.
 * @param {string} text
 * @returns {boolean}
 */
function isLargePaste(text) {
  return text.length > PASTE_TEXT_CHAR_THRESHOLD || text.split('\n').length > PASTE_TEXT_LINE_THRESHOLD;
}

/**
 * Renders attachment chips for `list` into `container`, wiring each chip's
 * remove button to `onRemove(id)`. Shared by the composer's own chip row
 * and the schedule modal's (see renderScheduleAttachmentChips) — the two
 * keep separate backing arrays, this just renders whichever one it's given.
 * @param {HTMLElement} container
 * @param {Attachment[]} list
 * @param {(id: string) => void} onRemove
 */
function renderAttachmentChipsInto(container, list, onRemove) {
  container.innerHTML = '';
  container.hidden = list.length === 0;
  for (const att of list) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.dataset.testid = 'attachment-chip';
    chip.innerHTML = att.type === 'image'
      ? `<img class="attachment-chip-thumb" src="data:${att.mediaType};base64,${att.data}" alt="">
         <span class="attachment-chip-label">${escHtml(att.name)}</span>
         <button type="button" class="attachment-chip-remove" data-testid="attachment-chip-remove">×</button>`
      : `<span class="attachment-chip-icon">📄</span>
         <span class="attachment-chip-label">${escHtml(att.name)}</span>
         <button type="button" class="attachment-chip-remove" data-testid="attachment-chip-remove">×</button>`;
    chip.querySelector('.attachment-chip-remove').addEventListener('click', () => onRemove(att.id));
    container.appendChild(chip);
  }
}

/**
 * Re-renders the pending-attachment chip row from `pendingAttachments`.
 */
function renderAttachmentChips() {
  renderAttachmentChipsInto(attachmentChips, pendingAttachments, (id) => {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
    renderAttachmentChips();
  });
}

msgInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items ?? [];
  let capturedImage = false;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addImageAttachment(file);
      capturedImage = true;
    }
  }
  if (capturedImage) return;

  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (isLargePaste(text)) {
    e.preventDefault();
    addTextAttachment(text);
  }
});

inputArea.addEventListener('dragover', (e) => e.preventDefault());
inputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer?.files ?? []) {
    if (file.type.startsWith('image/')) addImageAttachment(file);
  }
});

// ─── Dictation (push-to-talk speech-to-text) ──────────────────────────────────

const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition = null;
let isDictating = false;
let dictationBaseValue = '';

if (SpeechRecognitionCtor) {
  micBtn.hidden = false;
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let finalChunk = '';
    let interimChunk = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalChunk += transcript;
      else interimChunk += transcript;
    }
    if (finalChunk) dictationBaseValue += finalChunk;
    msgInput.value = dictationBaseValue + interimChunk;
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    const key = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'chat.micPermissionError'
      : 'chat.micNoSpeechError';
    showAttachmentError(t(key));
  };

  recognition.onend = () => {
    isDictating = false;
    micBtn.classList.remove('recording');
    micBtn.title = t('chat.micBtnTitle');
    msgInput.focus();
  };

  micBtn.addEventListener('click', () => {
    if (isDictating) {
      recognition.stop();
      return;
    }
    dictationBaseValue = msgInput.value ? msgInput.value.replace(/\s*$/, ' ') : '';
    recognition.lang = currentLocale;
    try {
      recognition.start();
      isDictating = true;
      micBtn.classList.add('recording');
      micBtn.title = t('chat.micBtnTitleRecording');
    } catch {
      // already started — ignore
    }
  });
} else {
  micBtn.hidden = true;
}

// ─── Input handling ───────────────────────────────────────────────────────────

/**
 * Resets the composer back to empty — shared by a normal send and a
 * successful schedule submission, since both consume whatever was typed.
 */
function clearComposer() {
  msgInput.value = '';
  pendingAttachments = [];
  renderAttachmentChips();
  hideMentionDropdown();
  msgInput.style.height = 'auto';
}

function submitMessage() {
  const content = msgInput.value.trim();
  if ((!content && pendingAttachments.length === 0) || !activeChatId) return;
  sendMessage(activeChatId, content, pendingAttachments);
  clearComposer();
}

msgInput.addEventListener('input', () => {
  // Auto-resize textarea
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
  updateComposerDropdown();
});

msgInput.addEventListener('keydown', (e) => {
  if (!mentionDropdown.hidden) {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionFocusIdx = Math.min(mentionFocusIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('focused', i === mentionFocusIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionFocusIdx = Math.max(mentionFocusIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('focused', i === mentionFocusIdx));
      return;
    }
    if (e.key === 'Enter' && mentionFocusIdx >= 0) {
      e.preventDefault();
      const focused = items[mentionFocusIdx];
      if (focused) focused.dispatchEvent(new MouseEvent('mousedown'));
      return;
    }
    if (e.key === 'Escape') {
      hideMentionDropdown();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
});

sendBtn.addEventListener('click', submitMessage);

quickMsgBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  quickMsgPanel.hidden = !quickMsgPanel.hidden;
});

// ─── Sidebar events ───────────────────────────────────────────────────────────

newChatBtn.addEventListener('click', () => {
  newChatForm.hidden = !newChatForm.hidden;
  if (!newChatForm.hidden) newChatInput.focus();
});

newChatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newChatInput.value.trim();
  if (!name) return;
  newChatInput.value = '';
  newChatForm.hidden = true;
  await createChat(name);
});

newChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') newChatForm.hidden = true;
});

// ─── Agent panel events ───────────────────────────────────────────────────────

addAgentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addAgentMenu.hidden = !addAgentMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!addAgentMenu.contains(e.target) && e.target !== addAgentBtn) {
    addAgentMenu.hidden = true;
  }
  if (!scheduledPanel.contains(e.target) && e.target !== scheduledBtn) {
    scheduledPanel.hidden = true;
  }
  if (!quickMsgPanel.contains(e.target) && e.target !== quickMsgBtn) {
    quickMsgPanel.hidden = true;
  }
  if (!searchBar.contains(e.target) && e.target !== searchBtn) {
    searchResultsEl.hidden = true;
  }
  if (!e.target.closest('.agent-menu-wrap')) {
    closeAllAgentMenus();
  }
  if (!e.target.closest('.category-menu')) {
    closeAllCategoryMenus();
  }
});

scheduledBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  scheduledPanel.hidden = !scheduledPanel.hidden;
});

freeRelayBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFreeRelay();
});

autoContinueBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAutoContinue();
});

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (searchBar.hidden) openSearchBar();
  else closeSearchBar();
});
searchClose.addEventListener('click', closeSearchBar);
searchInput.addEventListener('input', handleSearchInput);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearchBar();
});
jumpedBannerBackBtn.addEventListener('click', backToLatestMessages);

pageFirstBtn.addEventListener('click', () => loadMessagesPage(activeChatId, 1));
pagePrevBtn.addEventListener('click', () => loadMessagesPage(activeChatId, currentPage - 1));
pageNextBtn.addEventListener('click', () => loadMessagesPage(activeChatId, currentPage + 1));
pageLastBtn.addEventListener('click', () => loadMessagesPage(activeChatId, 'last'));

scheduleBtn.addEventListener('click', openScheduleModal);
scheduleClose.addEventListener('click', closeScheduleModal);
scheduleCancel.addEventListener('click', closeScheduleModal);
scheduleOverlay.addEventListener('click', (e) => { if (e.target === scheduleOverlay) closeScheduleModal(); });
scheduleForm.addEventListener('submit', handleScheduleFormSubmit);

settingsBtn.addEventListener('click', openSettingsModal);
settingsClose.addEventListener('click', closeSettingsModal);
settingsCancel.addEventListener('click', closeSettingsModal);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettingsModal(); });
settingsForm.addEventListener('submit', handleSettingsFormSubmit);

chatHeaderCollapseBtn.addEventListener('click', () => setCollapsed('chatHeader', true));
chatHeaderExpandBtn.addEventListener('click', () => setCollapsed('chatHeader', false));
sidebarCollapseBtn.addEventListener('click', () => setCollapsed('sidebar', true));
sidebarExpandBtn.addEventListener('click', () => setCollapsed('sidebar', false));
agentPanelCollapseBtn.addEventListener('click', () => setCollapsed('agentPanel', true));
agentPanelExpandBtn.addEventListener('click', () => setCollapsed('agentPanel', false));
sidebarToggleBtn.addEventListener('click', () => toggleDrawer(sidebarEl));
agentPanelToggleBtn.addEventListener('click', () => toggleDrawer(agentPanelEl));
drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeDrawer();
  closeImageLightbox();
  if (!grantsOverlay.hidden) closeGrantsModal();
});

/**
 * Alt+1..Alt+9 insert the Nth quick message into the composer, same as
 * clicking it in the ⚡ panel (see useQuickMessage) — a hotkey shortcut for
 * the same action, not a new send path. Ignored while a modal is open (its
 * own fields take priority) or there's no active chat to type into.
 */
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!/^[1-9]$/.test(e.key)) return;
  if (!activeChatId || msgInput.disabled) return;
  if (document.querySelector('[id$="-overlay"]:not([hidden])')) return;
  const qm = quickMessages[Number(e.key) - 1];
  if (!qm) return;
  e.preventDefault();
  useQuickMessage(qm.text);
});

imageLightboxOverlay.addEventListener('click', (e) => { if (e.target === imageLightboxOverlay) closeImageLightbox(); });

appLogo.addEventListener('click', () => openImageLightbox('assets/logo.png', appLogo.alt));

newAgentBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
agentForm.addEventListener('submit', handleAgentFormSubmit);
agentNameGenerateBtn.addEventListener('click', () => {
  agentNameInput.value = generateAgentName();
});
agentProviderSelect.addEventListener('change', applyProviderToAgentForm);
// A typed working directory is checked once typing pauses, not per keystroke.
let providerCheckTimer = null;
agentDirInput.addEventListener('input', () => {
  clearTimeout(providerCheckTimer);
  providerCheckTimer = setTimeout(refreshProviderAvailability, 400);
});
agentModelInput.addEventListener('change', () => {
  agentModelCustomInput.hidden = agentModelInput.value !== 'custom';
  if (agentModelInput.value === 'custom') agentModelCustomInput.focus();
});

agentDirBrowseBtn.addEventListener('click', openFolderBrowser);
browseClose.addEventListener('click', closeFolderBrowser);
browseCancel.addEventListener('click', closeFolderBrowser);
browseOverlay.addEventListener('click', (e) => { if (e.target === browseOverlay) closeFolderBrowser(); });
browsePathGo.addEventListener('click', () => loadBrowseDir(browsePathInput.value.trim()));
browsePathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadBrowseDir(browsePathInput.value.trim());
  }
});
browseSelect.addEventListener('click', () => {
  if (browseCurrentPath) agentDirInput.value = browseCurrentPath;
  closeFolderBrowser();
  refreshProviderAvailability();
});

noteClose.addEventListener('click', closeNoteModal);
noteCancel.addEventListener('click', closeNoteModal);
noteOverlay.addEventListener('click', (e) => { if (e.target === noteOverlay) closeNoteModal(); });
noteForm.addEventListener('submit', handleNoteFormSubmit);

grantsClose.addEventListener('click', closeGrantsModal);
grantsOverlay.addEventListener('click', (e) => { if (e.target === grantsOverlay) closeGrantsModal(); });

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  document.title = APP_NAME;
  appTitleEl.textContent = APP_NAME;
  appVersionEl.textContent = `v${APP_VERSION}`;

  renderColorGrid(colorGrid, selectedColor, (c) => { selectedColor = c; });
  // Suggestions for every compaction-window field (agent menu, new-agent
  // form, Settings); any other valid value can still be typed.
  $('#autocompact-presets').replaceChildren(...AUTOCOMPACT_PRESETS.map((value) => Object.assign(document.createElement('option'), { value })));

  const [agentsRes, chatsRes, settingsRes, quickMessagesRes] = await Promise.all([
    fetch('/api/agents'),
    fetch('/api/chats'),
    fetch('/api/settings'),
    fetch('/api/quick-messages'),
  ]);
  agents = await agentsRes.json();
  userSettings = await settingsRes.json();
  chats = await chatsRes.json();
  quickMessages = await quickMessagesRes.json();
  renderQuickMsgPanel();

  currentLocale = userSettings.locale ?? DEFAULT_LOCALE;
  applyTranslations();
  applyTheme(userSettings.theme ?? 'dark');

  renderChatList();
  renderAgentPanel();
  connectWs();

  // A ?chat=<id> in the URL (e.g. a link pasted from another tab/instance)
  // takes priority over this tab's own last-active chat, since opening a
  // shared link is a deliberate choice that should win over whatever this
  // tab happened to be on before.
  const targetChatId = getChatIdFromUrl() ?? sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
  if (targetChatId && chats.some((c) => c.id === targetChatId)) {
    await selectChat(targetChatId);
  } else if (targetChatId) {
    // Stale reference (chat since deleted) — drop it rather than trying to
    // restore something that no longer exists.
    sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
    syncChatIdToUrl(null);
  }

  // Lets the browser's Back/Forward buttons step through chat switches
  // pushed by selectChat's { push: true } callers, and also covers a
  // manually edited/cleared ?chat= param in the address bar.
  window.addEventListener('popstate', () => {
    const id = getChatIdFromUrl();
    if (id && id !== activeChatId && chats.some((c) => c.id === id)) {
      selectChat(id);
    } else if (!id && activeChatId) {
      showEmptyChatState();
    }
  });
}

init();
