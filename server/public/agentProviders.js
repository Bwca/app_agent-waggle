/**
 * @fileoverview The browser-facing side of agent providers: per-provider
 * details the UI needs, keyed by the same provider ids as the server's
 * registry (server/services/providers/index.js). Imported unmodified by
 * both the browser and the server, same as appName.js. The server's
 * provider modules can't be loaded in the browser, since they spawn
 * processes.
 */

/** The provider an agent runs as when nothing says otherwise. */
export const DEFAULT_PROVIDER_ID = 'claude';

/**
 * Default-name pools for a new agent, one per provider — a name hints at
 * what the agent runs as.
 * @type {Record<string, string[]>}
 */
const NAME_POOLS = {
  claude: [
    'Claire', 'Clara', 'Clarabelle', 'Clarence', 'Clarissa', 'Clark', 'Clarke',
    'Claude', 'Claudia', 'Claudette', 'Claudio', 'Claudius', 'Clay', 'Clayton',
    'Clancy', 'Clarion', 'Clarity', 'Claybourne',
    'Claudine', 'Claudina', 'Claus', 'Claudie', 'Claudiu', 'Claudell',
    'Claudelle', 'Claudian', 'Clavius', 'Claudel', 'Claudiano', 'Claudino',
  ],
};

/**
 * Returns the default-name generator for a provider: a function that picks
 * a random name from that provider's pool, avoiding collisions with
 * existing agent names (case-insensitive), and falls back to a numbered
 * suffix if every name in the pool is already taken.
 * @param {string} [providerId]
 * @returns {(takenNames: string[], random?: () => number) => string}
 */
export function nameGeneratorFor(providerId = DEFAULT_PROVIDER_ID) {
  const pool = NAME_POOLS[providerId];
  if (!pool) throw new Error(`No default names for agent provider: ${providerId}`);
  return (takenNames, random = Math.random) => {
    const taken = new Set(takenNames.map((name) => name.toLowerCase()));
    const free = pool.filter((name) => !taken.has(name.toLowerCase()));
    if (free.length) return free[Math.floor(random() * free.length)];

    // Every pool name is taken — suffix a random one with a number until unique.
    const base = pool[Math.floor(random() * pool.length)];
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  };
}
