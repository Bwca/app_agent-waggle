/**
 * @fileoverview The browser-facing side of agent providers: per-provider
 * details the UI needs, keyed by the same provider ids as the server's
 * registry (server/services/providers/index.js). Imported unmodified by
 * both the browser and the server, same as appName.js. The server's
 * provider modules can't be loaded in the browser, since they spawn
 * processes.
 *
 * Everything the UI shows or offers differently per provider comes from a
 * provider's ProviderDisplay (providerDisplayFor), so app.js never checks a
 * provider id itself. A new provider needs an entry in PROVIDER_DISPLAYS.
 */

/** The provider an agent runs as when nothing says otherwise. */
export const DEFAULT_PROVIDER_ID = 'claude';

/**
 * @typedef {Object} ProviderDisplay
 * @property {string} id - The provider id, as stored on the agent.
 * @property {string} label - Human name, e.g. in the New Agent provider picker.
 * @property {string} icon - Short glyph for the agent's provider badge.
 * @property {string[]} namePool - Default names for a new agent — a name
 *   hints at what the agent runs as (see nameGeneratorFor).
 * @property {string[] | null} modelAliases - Model-family shortcuts the
 *   model picker offers, or null when models are only ever typed as exact
 *   ids.
 * @property {string} modelExample - An exact model id, as a placeholder.
 * @property {boolean} autocompact - Whether the agent's context-compaction
 *   window (autocompactOverride, and the Settings default) applies.
 * @property {boolean} chromeAccess - Whether browser access can be granted.
 * @property {(resumeId: string) => string} resumeCommand - The terminal
 *   command that resumes the agent's session, for "copy session".
 * @property {(model: string) => string} formatModel - Short label for a
 *   model id the CLI reported.
 */

/**
 * "claude-opus-4-1-20250805" → "Opus 4.1"; anything that isn't a known
 * family comes back unchanged.
 * @param {string} model
 * @returns {string}
 */
function formatClaudeModel(model) {
  const familyMatch = model.match(/opus|sonnet|haiku|fable/i);
  if (!familyMatch) return model;
  const family = familyMatch[0][0].toUpperCase() + familyMatch[0].slice(1).toLowerCase();
  const withoutDate = model.replace(/-\d{8}$/, '');
  const version = withoutDate.split('-').filter((p) => /^\d+$/.test(p)).join('.');
  return version ? `${family} ${version}` : family;
}

/** @type {Record<string, ProviderDisplay>} */
const PROVIDER_DISPLAYS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    icon: '✳',
    namePool: [
      'Claire', 'Clara', 'Clarabelle', 'Clarence', 'Clarissa', 'Clark', 'Clarke',
      'Claude', 'Claudia', 'Claudette', 'Claudio', 'Claudius', 'Clay', 'Clayton',
      'Clancy', 'Clarion', 'Clarity', 'Claybourne',
      'Claudine', 'Claudina', 'Claus', 'Claudie', 'Claudiu', 'Claudell',
      'Claudelle', 'Claudian', 'Clavius', 'Claudel', 'Claudiano', 'Claudino',
    ],
    modelAliases: ['opus', 'sonnet', 'haiku', 'fable'],
    modelExample: 'claude-opus-4-1-20250805',
    autocompact: true,
    chromeAccess: true,
    resumeCommand: (resumeId) => `claude --resume ${resumeId}`,
    formatModel: formatClaudeModel,
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    icon: '⌬',
    namePool: [
      'Opal', 'Ophelia', 'Odette', 'Odile', 'Olive', 'Olivia', 'Oona', 'Opie',
      'Otto', 'Octavia', 'Octavian', 'Odin', 'Opaline', 'Oppie', 'Owen',
      'Oscar', 'Orla', 'Orson', 'Oliver', 'Odessa',
    ],
    modelAliases: null,
    modelExample: 'ollama/local-agent',
    autocompact: false,
    chromeAccess: false,
    resumeCommand: (resumeId) => `opencode --session ${resumeId}`,
    // "provider/model" — the model part is what tells agents apart.
    formatModel: (model) => model.split('/').pop() || model,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    icon: '↖',
    namePool: [
      'Curtis', 'Curt', 'Curie', 'Curran', 'Curzon', 'Curtiss', 'Curry', 'Curla',
      'Curtina', 'Curio', 'Curwen', 'Curley', 'Currie', 'Curtana', 'Cursa',
    ],
    modelAliases: null,
    modelExample: 'grok-4.7',
    autocompact: false,
    chromeAccess: false,
    resumeCommand: (resumeId) => `cursor-agent --resume ${resumeId}`,
    // "grok-4.7[context=256k,…]" — the settings in brackets are noise here.
    formatModel: (model) => (model === 'default[]' ? 'Auto' : model.split('[')[0] || model),
  },
};

/** Every provider id the UI knows, default first. */
export const PROVIDER_IDS = Object.keys(PROVIDER_DISPLAYS);

/**
 * @param {string} [providerId]
 * @returns {ProviderDisplay}
 */
export function providerDisplayFor(providerId = DEFAULT_PROVIDER_ID) {
  const display = PROVIDER_DISPLAYS[providerId];
  if (!display) throw new Error(`No display details for agent provider: ${providerId}`);
  return display;
}

/**
 * Returns the default-name generator for a provider: a function that picks
 * a random name from that provider's pool, avoiding collisions with
 * existing agent names (case-insensitive), and falls back to a numbered
 * suffix if every name in the pool is already taken.
 * @param {string} [providerId]
 * @returns {(takenNames: string[], random?: () => number) => string}
 */
export function nameGeneratorFor(providerId = DEFAULT_PROVIDER_ID) {
  const pool = PROVIDER_DISPLAYS[providerId]?.namePool;
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
