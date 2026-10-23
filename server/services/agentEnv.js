/**
 * @fileoverview The environment a provider's binary is started with: the
 * server's own, minus whatever that provider has no business seeing.
 * Reported live: every agent got the server's whole environment, so an
 * opencode or Cursor agent held Agentwaggle's MCP_AUTH_TOKEN, and a server
 * started from inside a Claude Code session handed that session's
 * variables to every agent too. What's trusted to one CLI stays with it:
 *
 * - Agentwaggle's own secrets go to no agent. Claude agents reach the MCP
 *   server through their own registration (its URL carries the token), not
 *   through the environment.
 * - Variables of the Claude Code session that launched the server (it may
 *   have been started from one) go to no agent: they belong to that
 *   session, not to an agent's own.
 * - A variable a provider owns (AgentProvider.env.owns: its API keys and
 *   settings) goes only to that provider's agents.
 * - The user's own git and SSH credentials go only to a provider trusted
 *   with them (AgentProvider.env.userCredentials).
 *
 * Anything else (PATH, HOME, locale, display) is passed through as is.
 */

import { listProviders } from './providers/index.js';

/** Agentwaggle's own secrets, loaded from server/.env or the shell. */
const APP_SECRETS = new Set(['MCP_AUTH_TOKEN']);

/**
 * Set by the Claude Code session that started the server, when it was
 * started from one (seen live on CLI 2.1.308): its identity, its messaging
 * channel and token, and its own settings. Not an agent's.
 */
const LAUNCHER_SESSION = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
]);

/**
 * The user's git and SSH credentials: an SSH agent, an askpass helper (VS
 * Code's hands out the user's git logins), GitHub tokens.
 * @param {string} name
 * @returns {boolean}
 */
function isUserCredential(name) {
  return /^(SSH_AUTH_SOCK|SSH_AGENT_PID|SSH_ASKPASS|GIT_ASKPASS|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/.test(name)
    || name.startsWith('VSCODE_GIT_');
}

/**
 * @param {import('./providers/index.js').AgentProvider} provider - Whose binary is being started.
 * @param {import('./providers/index.js').AgentProvider[]} [allProviders] - Every registered provider.
 * @param {NodeJS.ProcessEnv} [env] - The server's environment.
 * @returns {NodeJS.ProcessEnv}
 */
export function providerEnv(provider, allProviders = listProviders(), env = process.env) {
  const others = allProviders.filter((other) => other.id !== provider.id);
  /** @type {NodeJS.ProcessEnv} */
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (APP_SECRETS.has(name) || LAUNCHER_SESSION.has(name)) continue;
    if (isUserCredential(name) && !provider.env.userCredentials) continue;
    if (!provider.env.owns(name) && others.some((other) => other.env.owns(name))) continue;
    result[name] = value;
  }
  return result;
}
