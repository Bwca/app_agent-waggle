/**
 * @fileoverview Records the docs site's demo clips (docs/recordings/<slug>.json)
 * by driving a real, throwaway server instance in Puppeteer while rrweb
 * records the page. Agent replies are real `claude` turns (on the `haiku`
 * model, to keep a full re-record cheap), so a recording costs real usage.
 *
 *   cd tests && node demos/record.js                  # every clip
 *   cd tests && node demos/record.js chat-rename ...  # just these
 *
 * Every clip gets its own server and a fresh database holding nothing but
 * that clip's own agents and chats, in /tmp/agentwaggle-demo, so no real
 * chat, project name or home path can end up in a recording: an earlier
 * hand-made set leaked all three. Setup that isn't the point of a clip
 * (creating its agents, a search clip's history) happens before recording
 * starts; long waits for a reply are squeezed afterwards (see squeezeGaps).
 */

import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The browser build isn't in the package's exports; it sits next to the main one.
const RRWEB_SOURCE = readFileSync(join(dirname(require.resolve('@rrweb/record')), 'record.umd.min.cjs'), 'utf-8');

const PORT = Number(process.env.DEMO_PORT || 4310);
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_DIR = fileURLToPath(new URL('../../server', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../../docs/recordings', import.meta.url));
/** Not os.tmpdir(): a TMPDIR under the home directory would show in the UI. */
const WORK_ROOT = '/tmp/agentwaggle-demo';
const VIEWPORT = { width: 1600, height: 800 };
const MCP_TOKEN = 'demo-token';
/** Every demo agent's model: cheap and quick, and replies stay short. */
const MODEL = 'haiku';
const TURN_TIMEOUT_MS = 180_000;

// ─── Server and REST setup ───────────────────────────────────────────────────

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

/**
 * Starts a server with an empty database of its own.
 * @param {{ mcp?: boolean }} [opts] - `mcp` mounts /mcp, for the MCP clip.
 */
async function startServer({ mcp = false } = {}) {
  rmSync(WORK_ROOT, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });
  server = spawn('node', ['index.js'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_DB_FILE: join(WORK_ROOT, 'demo.sqlite3'),
      APP_LOG_DIR: join(WORK_ROOT, 'logs'),
      APP_LOG_LEVEL: 'silent',
      APP_TRANSCRIPT_LOG: '',
      // Set either way, so a token in server/.env can't mount /mcp.
      MCP_AUTH_TOKEN: mcp ? MCP_TOKEN : '',
    },
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Demo server did not start');
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => server.on('close', resolve));
  server = null;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 */
async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * Makes an agent's working directory, with any project files it needs.
 * @param {string} name
 * @param {Record<string, string>} [files] - Relative path → content.
 * @returns {string}
 */
function makeAgentDir(name, files = {}) {
  const dir = join(WORK_ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f5c2e7', '#94e2d5'];

/**
 * @param {string} name
 * @param {object} [extra] - More POST /api/agents fields.
 */
function createAgent(name, extra = {}) {
  const color = COLORS[name.length % COLORS.length];
  return api('POST', '/api/agents', { name, color, workingDir: makeAgentDir(name, extra.files), modelOverride: MODEL, ...extra, files: undefined });
}

/**
 * @param {string} name
 * @param {object[]} [members]
 * @param {object} [patch] - Fields to PATCH right after, e.g. a category.
 */
async function createChat(name, members = [], patch = null) {
  const chat = await api('POST', '/api/chats', { name, memberAgentIds: members.map((a) => a.id) });
  return patch ? api('PATCH', `/api/chats/${chat.id}`, patch) : chat;
}

// ─── Page driving ────────────────────────────────────────────────────────────

const tid = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A recording session: one page, rrweb events collected as they're emitted. */
class Session {
  /** @param {import('puppeteer').Page} page */
  constructor(page) {
    this.page = page;
    /** @type {object[]} */
    this.events = [];
    this.mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  }

  /** @param {string} [path] - e.g. `/?chat=<id>` */
  async open(path = '/') {
    await this.page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle0' });
    await this.page.waitForFunction(() => document.querySelector('[data-testid="conn-dot"]')?.classList.contains('connected'), { timeout: 10_000 });
    await sleep(500);
  }

  async startRecording() {
    await this.page.evaluate(() => {
      window.__stopRecording = window.rrwebRecord.record({ emit: (event) => window.__rrwebEmit(event) });
    });
    await sleep(1200);
  }

  /** Holds the final state for a beat: the player ends on the last event. */
  async stopRecording() {
    await sleep(2500);
    await this.page.evaluate(() => {
      window.rrwebRecord.record.addCustomEvent('end', {});
      window.__stopRecording?.();
    });
  }

  /** Glides the cursor to an element's center, the way a hand would. */
  async moveTo(selector) {
    return this.moveToHandle(await this.page.waitForSelector(selector, { visible: true, timeout: 10_000 }));
  }

  /** @param {import('puppeteer').ElementHandle} handle */
  async moveToHandle(handle) {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Stepped by hand: Puppeteer's own `steps` all land in the same instant.
    const from = this.mouse;
    const steps = Math.max(12, Math.round(Math.hypot(x - from.x, y - from.y) / 25));
    for (let i = 1; i <= steps; i++) {
      const eased = 0.5 - Math.cos((i / steps) * Math.PI) / 2;
      await this.page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
      await sleep(14);
    }
    this.mouse = { x, y };
    await sleep(250);
    return handle;
  }

  async click(selector) {
    await this.moveTo(selector);
    await this.page.mouse.click(this.mouse.x, this.mouse.y);
    await sleep(500);
  }

  /** @param {import('puppeteer').ElementHandle} handle */
  async clickHandle(handle) {
    await this.moveToHandle(handle);
    await this.page.mouse.click(this.mouse.x, this.mouse.y);
    await sleep(500);
  }

  /** Types at a human pace into the focused field. */
  async type(text) {
    for (const char of text) {
      await this.page.keyboard.type(char);
      await sleep(35 + Math.random() * 45);
    }
    await sleep(400);
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await sleep(500);
  }

  /** Clicks the composer, types a message and sends it. */
  async send(text) {
    await this.click(tid('msg-input'));
    await this.type(text);
    await this.press('Enter');
  }

  /**
   * Waits until the chat shows at least `count` agent messages and nothing
   * is still streaming.
   * @param {number} count
   */
  async waitForReplies(count) {
    await this.page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="message"][data-role="agent"]').length >= n
        && !document.querySelector('[data-testid="streaming-bubble"]'),
      { timeout: TURN_TIMEOUT_MS, polling: 500 },
      count,
    );
    await sleep(1500);
  }

  /** Picks a `<select>` option, after moving to the select like a user would. */
  async select(selector, value) {
    await this.click(selector);
    await this.page.select(selector, value);
    await sleep(600);
  }
}

/** How many agent messages the open chat shows. */
function agentMessageCount(session) {
  return session.page.$$eval('[data-testid="message"][data-role="agent"]', (els) => els.length);
}

// ─── The clips ───────────────────────────────────────────────────────────────

/**
 * Each clip sets up its state, opens the page, records, and stops. Keys are
 * the slugs docs/index.html's USE_CASE_SLUGS loads.
 * @type {Record<string, { mcp?: boolean, speech?: string, run: (s: Session) => Promise<void> }>}
 */
const CLIPS = {
  'create-agent-chat': {
    async run(s) {
      makeAgentDir('Aria');
      await s.open();
      await s.startRecording();
      await s.click(tid('new-chat-btn'));
      await s.type('Demo Chat');
      await s.press('Enter');
      await s.click(tid('new-agent-btn'));
      await s.click(tid('agent-name-input'));
      await s.type('Aria');
      await s.click(tid('agent-dir-input'));
      await s.type(join(WORK_ROOT, 'Aria'));
      await s.select(tid('agent-model-select'), MODEL);
      await s.click(tid('modal-submit'));
      await s.page.waitForSelector(tid('agent-item'), { timeout: 10_000 });
      await sleep(800);
      await s.send("Hi Aria! Please reply with exactly: Hi, I'm Aria, ready to help.");
      await s.waitForReplies(1);
    },
  },

  'mention-relay': {
    async run(s) {
      const nora = await createAgent('Nora');
      const theo = await createAgent('Theo');
      const chat = await createChat('Relay Demo', [nora, theo]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.send('@Nora reply in one short line that @-mentions Theo and asks them to confirm they can take the release notes.');
      await s.waitForReplies(2);
    },
  },

  'permission-flow': {
    async run(s) {
      const outside = join(WORK_ROOT, 'outside-scope');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'notes.txt'), 'Launch checklist: docs done, QA signed off, ship on Friday.\n');
      const rex = await createAgent('Rex');
      const chat = await createChat('Permission Demo', [rex]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.send(`Please use the Read tool to read ${join(outside, 'notes.txt')} and tell me in one line what it says.`);
      await s.page.waitForSelector(tid('perm-grant-btn'), { visible: true, timeout: TURN_TIMEOUT_MS });
      await sleep(1500);
      await s.click(tid('perm-grant-btn'));
      await s.waitForReplies(2);
    },
  },

  'chat-rename': {
    async run(s) {
      await createChat('Release Planning');
      const chat = await createChat('Old Chat Name');
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      const item = `${tid('chat-item')}[data-chat-id="${chat.id}"]`;
      await s.moveTo(item);
      await s.click(`${item} ${tid('chat-rename-btn')}`);
      await s.page.keyboard.down('Control');
      await s.page.keyboard.press('a');
      await s.page.keyboard.up('Control');
      await s.type('Renamed Project');
      await s.press('Enter');
    },
  },

  'free-relay': {
    async run(s) {
      const nora = await createAgent('Nora');
      const theo = await createAgent('Theo');
      const chat = await createChat('Free Relay Demo', [nora, theo]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('free-relay-btn'));
      await s.send("@Nora let's count to 4 with Theo. You say 1. Then each of you replies with only the next number followed by an @-mention of the other; whoever says 4 mentions nobody.");
      await s.waitForReplies(4);
    },
  },

  'observer-agent': {
    async run(s) {
      const nora = await createAgent('Nora');
      const theo = await createAgent('Theo');
      const vera = await createAgent('Vera', { isObserver: true });
      const chat = await createChat('Team Updates', [nora, theo, vera]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.send('Team, quick status: the export feature is code-complete and heading to QA tomorrow. (Just acknowledge in one short sentence, no @-mentions.)');
      await s.waitForReplies(2);
      await s.send('Also heads up: the dashboard revamp kicks off next week once QA wraps up. (Just acknowledge in one short sentence, no @-mentions.)');
      await s.waitForReplies(4);
      await s.send("@Vera you've been quiet — can you summarize everything the team mentioned so far, in two short bullet points?");
      await s.waitForReplies(5);
    },
  },

  'skill-invocation': {
    async run(s) {
      const sage = await createAgent('Sage', {
        files: {
          '.claude/commands/standup.md': '---\ndescription: Post a short standup update\n---\nWrite a standup update for the fictional project "Lighthouse" as three bullets (Yesterday, Today, Blockers), under 40 words in total.\n',
        },
      });
      const chat = await createChat('Standup', [sage]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('msg-input'));
      await s.type('@Sage /standup');
      // A suggestion list may still be open on the command: Enter takes it,
      // and a second Enter sends.
      await s.press('Enter');
      if (await s.page.$eval(tid('msg-input'), (el) => el.value.trim() !== '')) await s.press('Enter');
      await s.waitForReplies(1);
    },
  },

  'message-search': {
    async run(s) {
      const theo = await createAgent('Theo');
      const chat = await createChat('Kitchen Notes', [theo]);
      await s.open(`/?chat=${chat.id}`);
      const questions = [
        'In one sentence: at what temperature does water start boiling at sea level?',
        'In one sentence: how long should I boil an egg for a soft yolk?',
        'In one sentence: should pasta water be salted?',
        'In one sentence: what is the best way to store fresh basil?',
        'In one sentence: how do I keep rice from getting sticky?',
        'In one sentence: how do I thicken a sauce without flour?',
        'In one sentence: why do onions make your eyes water?',
        'In one sentence: how hot should oil be for deep frying?',
      ];
      for (const [i, question] of questions.entries()) {
        await s.page.click(tid('msg-input'));
        await s.page.type(tid('msg-input'), question);
        await s.page.keyboard.press('Enter');
        await s.waitForReplies(i + 1);
      }
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('search-btn'));
      await s.type('boiling');
      await s.page.waitForSelector(tid('search-result-item'), { visible: true, timeout: 10_000 });
      await sleep(1500);
      // The oldest match, by now scrolled well out of view, so the jump shows.
      const results = await s.page.$$(tid('search-result-item'));
      const texts = await Promise.all(results.map((r) => r.evaluate((el) => el.textContent)));
      await s.clickHandle(results[texts.findIndex((text) => /sea level/.test(text))]);
      await sleep(2500);
    },
  },

  'quick-messages': {
    async run(s) {
      const aria = await createAgent('Aria');
      const chat = await createChat('Daily Work', [aria]);
      await api('POST', '/api/quick-messages', { text: 'Please continue with the plan we discussed.' });
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('msg-input'));
      await s.type('@Aria ');
      await s.press('Escape');
      await s.click(tid('quick-msg-btn'));
      await s.click(tid('quick-msg-item-text'));
      await sleep(1000);
      await s.click(tid('quick-msg-btn'));
      await s.click(tid('quick-msg-add-btn'));
      await s.click(tid('confirm-text-input'));
      await s.type('Looks good, ship it!');
      await s.click(tid('confirm-ok'));
      await sleep(1200);
    },
  },

  'model-switch': {
    async run(s) {
      const aria = await createAgent('Aria', { modelOverride: undefined });
      const chat = await createChat('Model Demo', [aria]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('agent-menu-btn'));
      await s.click(tid('agent-model-btn'));
      await s.select(tid('confirm-model-select'), 'custom');
      await s.click(tid('confirm-model-custom-input'));
      await s.type('claude-opus-4-1-20250805');
      await s.click(tid('confirm-ok'));
      await sleep(1500);
      await s.click(tid('agent-menu-btn'));
      await s.click(tid('agent-model-btn'));
      await s.select(tid('confirm-model-select'), 'sonnet');
      await s.click(tid('confirm-ok'));
      await sleep(1500);
      // The badge shows the model a turn reports, so one tiny turn shows the switch.
      await s.send('Reply with just: switched');
      await s.waitForReplies(1);
    },
  },

  'chat-categories': {
    async run(s) {
      await createChat('Login Issue', [], { category: 'Support' });
      const billing = await createChat('Billing Bug');
      const roadmap = await createChat('Roadmap Q4');
      await s.open(`/?chat=${billing.id}`);
      await s.startRecording();
      const billingItem = `${tid('chat-item')}[data-chat-id="${billing.id}"]`;
      await s.moveTo(billingItem);
      await s.click(`${billingItem} ${tid('chat-tag-btn')}`);
      await s.click(`${billingItem} ${tid('category-menu-item')}`);
      await sleep(1000);
      const roadmapItem = `${tid('chat-item')}[data-chat-id="${roadmap.id}"]`;
      await s.moveTo(roadmapItem);
      await s.click(`${roadmapItem} ${tid('chat-tag-btn')}`);
      await s.click(`${roadmapItem} ${tid('category-menu-new-btn')}`);
      await s.type('Planning');
      await s.press('Enter');
      await sleep(1000);
    },
  },

  'agent-budget': {
    async run(s) {
      // Sonnet: haiku turns cost so little the badge would stay at $0.00.
      const pip = await createAgent('Pip', { modelOverride: 'sonnet' });
      const chat = await createChat('Budget Demo', [pip]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.send('Name one benefit of unit tests, briefly.');
      await s.waitForReplies(1);
      await s.moveTo(tid('agent-usage'));
      await sleep(1500);
      await s.send('And one drawback, just as briefly?');
      await s.waitForReplies(2);
      await s.moveTo(tid('agent-usage'));
      await sleep(1500);
    },
  },

  'mcp-server': {
    mcp: true,
    async run(s) {
      const dir = makeAgentDir('Pip');
      await s.open();
      await s.startRecording();
      const driver = runMcpDriver(
        `Use the agentwaggle tools, and nothing else: create an agent named Pip with working directory ${dir} and model "${MODEL}", `
        + 'create a chat named "MCP Demo" with Pip in it, then send_message "@Pip reply with exactly: Hello from inside Agentwaggle!" to that chat '
        + 'and tell me the reply.',
      );
      // The UI only opens a chat that's clicked: watching is the one click.
      await s.page.waitForSelector(tid('chat-item-name'), { visible: true, timeout: TURN_TIMEOUT_MS });
      await sleep(800);
      await s.click(tid('chat-item-name'));
      await s.waitForReplies(1);
      await driver;
    },
  },

  dictation: {
    speech: 'Hey Juno, just checking in by voice — can you hear me?',
    async run(s) {
      const juno = await createAgent('Juno');
      const chat = await createChat('Voice Demo', [juno]);
      await s.open(`/?chat=${chat.id}`);
      await s.startRecording();
      await s.click(tid('mic-btn'));
      await s.page.waitForFunction(() => window.__speechDone === true, { timeout: 20_000 });
      await sleep(800);
      await s.click(tid('mic-btn'));
      await s.click(tid('msg-input'));
      await s.press('Enter');
      await s.waitForReplies(1);
    },
  },
};

/**
 * Has a real `claude -p`, connected to nothing but this server's /mcp,
 * carry out `prompt`.
 * @param {string} prompt
 * @returns {Promise<void>}
 */
function runMcpDriver(prompt) {
  const mcpConfig = JSON.stringify({ mcpServers: { agentwaggle: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp?token=${MCP_TOKEN}` } } });
  const child = spawn(process.env.CLAUDE_BIN || 'claude', [
    '-p', prompt,
    '--model', MODEL,
    '--strict-mcp-config', `--mcp-config=${mcpConfig}`,
    '--allowedTools=mcp__agentwaggle',
  ], { cwd: WORK_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[mcp driver] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[mcp driver] ${d}`));
  return new Promise((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`claude -p exited ${code}`)))));
}

/**
 * Stands in for the browser's speech recognition, which headless Chrome
 * doesn't have: after start(), "hears" `transcript` a word at a time as
 * interim results, then delivers it as final, through the same events
 * the real API fires.
 * @param {string} transcript
 */
function fakeSpeechRecognition(transcript) {
  class FakeRecognition {
    start() {
      const words = transcript.split(' ');
      let i = 0;
      const emit = (text, isFinal) => {
        const result = Object.assign([{ transcript: text }], { isFinal });
        this.onresult?.({ resultIndex: 0, results: [result] });
      };
      const next = () => {
        i += 1;
        if (i < words.length) {
          emit(words.slice(0, i).join(' '), false);
          this.timer = setTimeout(next, 260 + Math.random() * 200);
        } else {
          emit(transcript, true);
          window.__speechDone = true;
        }
      };
      this.timer = setTimeout(next, 700);
    }

    stop() {
      clearTimeout(this.timer);
      setTimeout(() => this.onend?.(), 100);
    }
  }
  window.SpeechRecognition = FakeRecognition;
}

// ─── Post-processing ─────────────────────────────────────────────────────────

/**
 * Squeezes every gap over 1.5s (mostly waiting on a reply) down to a
 * 1.4–2.6s beat, varied so it doesn't read as a jump cut, and shifts later
 * events back to match. Seeded by the slug, so a re-run is reproducible.
 * @param {object[]} events
 * @param {string} slug
 */
function squeezeGaps(events, slug) {
  let seed = [...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let shift = 0;
  return events.map((event, i) => {
    if (i > 0) {
      const gap = event.timestamp - events[i - 1].timestamp;
      if (gap > 1500) shift += gap - Math.round(1400 + random() * 1200);
    }
    return { ...event, timestamp: event.timestamp - shift };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function record(browser, slug) {
  const clip = CLIPS[slug];
  await startServer({ mcp: clip.mcp });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const session = new Session(page);
  await page.exposeFunction('__rrwebEmit', (event) => session.events.push(event));
  await page.evaluateOnNewDocument(RRWEB_SOURCE);
  if (clip.speech) await page.evaluateOnNewDocument(fakeSpeechRecognition, clip.speech);
  try {
    await clip.run(session);
    await session.stopRecording();
    // For checking a clip by eye; not part of what's published.
    if (process.env.DEMO_SCREENSHOTS) await page.screenshot({ path: join(process.env.DEMO_SCREENSHOTS, `${slug}.png`) });
  } finally {
    await page.close();
    await stopServer();
  }
  const events = squeezeGaps(session.events, slug);
  // Relative, so the replay finds the logo in docs/assets/ instead of asking
  // a server that only existed while recording.
  writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(events).replaceAll(`${BASE_URL}/assets/`, 'assets/'));
  const seconds = (events.at(-1).timestamp - events[0].timestamp) / 1000;
  console.log(`✔ ${slug}: ${events.length} events, ${seconds.toFixed(0)}s`);
}

const slugs = process.argv.slice(2);
for (const slug of slugs) if (!CLIPS[slug]) throw new Error(`Unknown clip: ${slug} (known: ${Object.keys(CLIPS).join(', ')})`);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  for (const slug of slugs.length ? slugs : Object.keys(CLIPS)) await record(browser, slug);
} finally {
  await browser.close();
  rmSync(WORK_ROOT, { recursive: true, force: true });
}
