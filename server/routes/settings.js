/**
 * @fileoverview REST routes for user-configurable settings.
 * Mounted at /api/settings.
 */

import { Router } from 'express';
import { getUserDisplayName, setUserDisplayName, getUserColor, setUserColor, getUserLocale, setUserLocale, getUserTheme, setUserTheme, getDefaultAutocompact, setDefaultAutocompact, getAgents } from '../store/db.js';
import { killAgent, setAutocompactDefault } from '../services/agentProcessManager.js';
import { AUTOCOMPACT_WINDOW } from '../services/providers/claude.js';
import { normalizeAutocompact } from '../public/autocompact.js';
import { providerDisplayFor } from '../public/agentProviders.js';
import { SUPPORTED_LOCALES } from '../public/i18n/index.js';
import { t } from '../i18n/t.js';

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const SUPPORTED_THEMES = ['dark', 'light'];

const router = Router();

/**
 * Current settings, as both GET and PUT return them. `defaultAutocompact`
 * is '' when unset, and `autocompactFallback` is what applies then (the
 * APP_AUTOCOMPACT env var, or the built-in default), so the UI can show it.
 * @returns {object}
 */
function currentSettings() {
  return {
    userDisplayName: getUserDisplayName(),
    userColor: getUserColor(),
    locale: getUserLocale(),
    theme: getUserTheme(),
    defaultAutocompact: getDefaultAutocompact() ?? '',
    autocompactFallback: AUTOCOMPACT_WINDOW,
  };
}

/**
 * GET /api/settings
 * Returns current settings.
 */
router.get('/', (_req, res) => {
  res.json(currentSettings());
});

/**
 * PUT /api/settings
 * Updates settings.
 * @param {Object} req.body
 * @param {string} req.body.userDisplayName - New display name for the user
 * @param {string} req.body.userColor - New message color, hex e.g. "#a6adc8"
 * @param {string} req.body.locale - New UI language, e.g. "en-CA" or "fr-CA"
 * @param {string} req.body.theme - New UI theme, "dark" or "light"
 * @param {string} [req.body.defaultAutocompact] - Context-compaction window
 *   for agents with no override of their own (see normalizeAutocompact for
 *   the accepted values); '' clears it back to autocompactFallback.
 */
router.put('/', async (req, res) => {
  const userDisplayName = typeof req.body.userDisplayName === 'string' ? req.body.userDisplayName.trim() : '';
  if (!userDisplayName) return res.status(400).json({ error: t('errors.displayNameRequired') });

  const userColor = req.body.userColor;
  if (userColor !== undefined && !HEX_COLOR_RE.test(userColor)) {
    return res.status(400).json({ error: t('errors.invalidColor') });
  }

  const locale = req.body.locale;
  if (locale !== undefined && !SUPPORTED_LOCALES.includes(locale)) {
    return res.status(400).json({ error: t('errors.invalidLocale', { locales: SUPPORTED_LOCALES.join(', ') }) });
  }

  const theme = req.body.theme;
  if (theme !== undefined && !SUPPORTED_THEMES.includes(theme)) {
    return res.status(400).json({ error: t('errors.invalidTheme', { themes: SUPPORTED_THEMES.join(', ') }) });
  }

  const rawAutocompact = req.body.defaultAutocompact;
  const defaultAutocompact = typeof rawAutocompact === 'string' && rawAutocompact.trim() !== ''
    ? normalizeAutocompact(rawAutocompact)
    : rawAutocompact === undefined ? undefined : '';
  if (defaultAutocompact === null) {
    return res.status(400).json({ error: t('errors.invalidAutocompact') });
  }

  await setUserDisplayName(userDisplayName);
  if (userColor !== undefined) await setUserColor(userColor);
  if (locale !== undefined) await setUserLocale(locale);
  if (theme !== undefined) await setUserTheme(theme);
  if (defaultAutocompact !== undefined && defaultAutocompact !== (getDefaultAutocompact() ?? '')) {
    await setDefaultAutocompact(defaultAutocompact);
    setAutocompactDefault(defaultAutocompact);
    // A running process keeps the window it started with, so every agent
    // that goes by the default gets restarted. killAgent waits out a turn
    // in progress first, and the next turn resumes the same session, so
    // nothing is cut off or forgotten. Not awaited: a busy agent's turn
    // can run for minutes, and saving Settings shouldn't wait on it. An
    // agent whose CLI has no compaction window isn't affected at all.
    for (const agent of getAgents()) {
      if (!agent.autocompactOverride && providerDisplayFor(agent.provider).autocompact) killAgent(agent.id);
    }
  }
  res.json(currentSettings());
});

export default router;
