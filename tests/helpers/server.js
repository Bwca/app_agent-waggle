/**
 * @fileoverview Helpers to start/stop the Agentwaggle server for E2E tests.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

/** Tests run on a separate port so they don't conflict with the dev server. */
export const TEST_PORT = 3099;
const SERVER_URL = `http://localhost:${TEST_PORT}`;
const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 10_000;

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;

/**
 * Spawns the server process and waits until /health responds.
 * @param {Record<string, string>} [envOverrides] - Extra/overriding env vars
 *   for this one spawn — e.g. `{ MCP_AUTH_TOKEN: 'test-token' }` for a suite
 *   that needs the MCP server mounted, which every other suite leaves unset
 *   (mirrors the base env's own APP_TRANSCRIPT_LOG-clearing reasoning below:
 *   only the suite that actually needs a var should be the one setting it).
 * @returns {Promise<void>}
 */
export async function startServer(envOverrides = {}) {
  serverProcess = spawn('node', ['index.js'], {
    // fileURLToPath, not raw `.pathname` — see tests/run.js for why.
    cwd: fileURLToPath(new URL('../../server', import.meta.url)),
    stdio: 'pipe',
    // APP_TRANSCRIPT_LOG explicitly cleared, not just left unset — it
    // spreads from the CURRENT process.env first, so if whoever's running
    // the suite happens to have it set globally for their own debugging,
    // test runs would otherwise non-deterministically start writing
    // transcript files to disk.
    env: { ...process.env, PORT: String(TEST_PORT), APP_DB_FILE: ':memory:', APP_LOG_LEVEL: 'silent', APP_TRANSCRIPT_LOG: '', ...envOverrides },
  });

  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer();
}

/**
 * Kills the server process.
 * @returns {Promise<void>}
 */
export async function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  await new Promise((resolve) => serverProcess.on('close', resolve));
  serverProcess = null;
}

/**
 * Resets all data via the /__reset endpoint.
 * @returns {Promise<void>}
 */
export async function resetData() {
  const res = await fetch(`${SERVER_URL}/__reset`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
}

/**
 * Polls /health until the server is ready or the timeout is exceeded.
 * @returns {Promise<void>}
 */
async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Server did not start within ${STARTUP_TIMEOUT_MS}ms`);
}
