/**
 * @fileoverview Express + WebSocket server entry point.
 * REST API on /api, WebSocket at /ws, static files from /public.
 */

import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadDb, resetAll, getChats, getAgent, getDefaultAutocompact } from './store/db.js';
import createAgentsRouter from './routes/agents.js';
import createChatsRouter from './routes/chats.js';
import browseRouter from './routes/browse.js';
import settingsRouter from './routes/settings.js';
import providersRouter from './routes/providers.js';
import quickMessagesRouter from './routes/quickMessages.js';
import { mountMcp } from './mcp/index.js';
import { handleConnection } from './ws/handler.js';
import { initScheduler } from './services/scheduler.js';
import { spawnForAgent, killAll, setAutocompactDefault } from './services/agentProcessManager.js';
import { logger } from './logger.js';
import { APP_NAME } from './public/appName.js';

const log = logger.child({ component: 'index' });

// Anything reaching here means the process is in an undefined state —
// log it properly (a raw uncaught-exception stack trace on stderr would
// otherwise never make it into the structured file record) and let a
// process manager restart the server, rather than trying to limp on.
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// Optional local secrets (MCP_AUTH_TOKEN, etc.) survive a reboot this way —
// a plain shell `export` only lives in that one terminal session, so past
// restarts the MCP server silently came back disabled. Loaded from a file
// next to this one so it works regardless of the CWD the process is
// launched from. Absence is fine (real env vars still take precedence /
// still work standalone); any other read error is unexpected and fatal.
try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const PORT = process.env.PORT || 3001;

const app = express();
const server = createServer(app);
// Comfortably above the client's own MAX_IMAGE_BYTES(5MB) × MAX_ATTACHMENTS(5) cap.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 30 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  handleConnection(ws, req, wss);
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Scoped to /api — logging every static asset request (JS/CSS/HTML) would
// just be noise, not signal.
app.use('/api', (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    log.info({ method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }, 'api request');
  });
  next();
});

app.use('/api/agents', createAgentsRouter(wss));
app.use('/api/chats', createChatsRouter(wss));
app.use('/api/browse', browseRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/providers', providersRouter);
app.use('/api/quick-messages', quickMessagesRouter);

mountMcp(app, wss);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Test-only: wipe all data so E2E tests can start from a clean state
app.delete('/__reset', async (_req, res) => {
  // Every agent process still alive at this point belongs to a chat/agent
  // that's about to no longer exist in the DB — kill them all so processes
  // never accumulate/leak across a test file's many resetData() calls.
  await killAll();
  await resetAll();
  setAutocompactDefault(null);
  res.json({ ok: true });
});

/**
 * Re-arms a persistent process for every agent already in a chat — mirrors
 * initScheduler's re-arm-at-startup pattern. Live processes are purely
 * in-memory, so a restart would otherwise silently leave every agent
 * "lazy" again until its next message despite having been eagerly spawned
 * before the restart.
 * @returns {void}
 */
function initAgentProcesses() {
  const memberIds = new Set(getChats().flatMap((c) => c.memberAgentIds));
  for (const agentId of memberIds) {
    const agent = getAgent(agentId);
    if (agent) spawnForAgent(agent);
  }
}

/**
 * Kills every live agent process before the Node process itself exits.
 * Necessary now that agents can have long-lived children: `spawn()`
 * doesn't put them in their own process group, so a plain `kill <pid>` on
 * this process (exactly what tests/helpers/server.js's stopServer() does,
 * and what a real deploy's process manager would do) only signals THIS
 * process — any live `claude` children would otherwise be orphaned, not
 * reaped.
 * @param {NodeJS.Signals} signal
 */
async function gracefulShutdown(signal) {
  log.info({ signal }, 'shutting down agent processes');
  await killAll();
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

await loadDb();
// Before initAgentProcesses, so the processes it re-arms start with it.
setAutocompactDefault(getDefaultAutocompact());
initScheduler(wss);
initAgentProcesses();
// Bound explicitly to loopback: agents can execute real shell/file tools
// against the host filesystem, so this must never be reachable from the
// network, regardless of the host's firewall configuration.
server.listen(PORT, '127.0.0.1', () => {
  log.info({ port: PORT }, `${APP_NAME} running on http://localhost:${PORT}`);
});
