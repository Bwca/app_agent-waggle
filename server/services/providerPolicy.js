/**
 * @fileoverview Which provider a new agent may run as, under Settings'
 * multi-provider mode. With it off (the default), every new agent runs as
 * Claude Code, the default provider, and asking for another is refused.
 * With it on, the user takes on the risk of the other providers: any
 * registered one can be asked for, and one not asked for runs as the
 * default provider chosen in Settings. Agents created while it was on keep
 * running after it's turned off; only creating more is refused.
 */

import { getDefaultProvider, getMultiProvider } from '../store/db.js';
import { DEFAULT_PROVIDER_ID, hasProvider } from './providers/index.js';
import { t } from '../i18n/t.js';

/**
 * The provider a new agent runs as when none is asked for.
 * @returns {string}
 */
export function defaultProviderId() {
  if (!getMultiProvider()) return DEFAULT_PROVIDER_ID;
  const chosen = getDefaultProvider();
  return hasProvider(chosen) ? chosen : DEFAULT_PROVIDER_ID;
}

/**
 * Resolves the provider a new agent asked for, or says why it can't run as it.
 * @param {string | undefined} requestedId - What the request asked for, if anything.
 * @returns {{ providerId: string } | { error: string }}
 */
export function newAgentProvider(requestedId) {
  const providerId = requestedId ?? defaultProviderId();
  if (!hasProvider(providerId)) return { error: t('errors.unknownProvider', { provider: providerId }) };
  if (providerId !== DEFAULT_PROVIDER_ID && !getMultiProvider()) {
    return { error: t('errors.multiProviderOff', { provider: providerId }) };
  }
  return { providerId };
}
