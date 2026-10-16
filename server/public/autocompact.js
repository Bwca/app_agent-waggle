/**
 * @fileoverview Validates a context-compaction window — the value passed to
 * the `claude` CLI's `--autocompact` flag — imported unmodified by both the
 * browser (server/public/) and the server, same pattern as appName.js, so
 * the agent menu and the Settings modal reject exactly what the server does.
 *
 * Confirmed against the installed CLI (2.1.301): it accepts "auto" in any
 * case, or 100k–1M tokens written as a plain number ("150000"), with a "k"
 * ("150k", "200K"), or with an "m" ("1M"). "1.5M" and anything outside the
 * range fail the CLI at startup, which would leave the agent unable to run
 * at all, so they're refused here first. A bare number under 1,000 is the
 * CLI's shorthand for thousands ("200" means 200k); it's refused rather
 * than guessed at, since "200" reads like 200 tokens.
 */

/** Smallest and largest window the CLI accepts, in tokens. */
export const AUTOCOMPACT_MIN_TOKENS = 100_000;
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000;

/** Offered as quick picks in the UI; any other valid value can be typed. */
export const AUTOCOMPACT_PRESETS = ['auto', '100k', '200k', '400k', '1M'];

/**
 * Returns the canonical form of a compaction window ("auto", "150k", "1M",
 * or a plain token count like "150500"), or null if the CLI would reject it.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeAutocompact(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto') return 'auto';
  const match = /^(\d+)([km]?)$/.exec(trimmed);
  if (!match) return null;
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  const tokens = Number(match[1]) * multiplier;
  if (tokens < AUTOCOMPACT_MIN_TOKENS || tokens > AUTOCOMPACT_MAX_TOKENS) return null;
  if (tokens === 1_000_000) return '1M';
  return tokens % 1_000 === 0 ? `${tokens / 1_000}k` : String(tokens);
}
