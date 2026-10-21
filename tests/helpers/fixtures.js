/**
 * @fileoverview Ephemeral working-directory fixtures for E2E tests.
 * Agents need a real, existing directory as their `workingDir` (it's passed
 * to the Claude CLI as `cwd` and `--add-dir`), so tests create throwaway
 * temp directories instead of pointing at real project folders on disk.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** @type {Set<string>} Absolute paths of directories created via {@link agentDir}. */
const createdDirs = new Set();

/**
 * Creates a fresh temp directory to use as an agent's `workingDir`.
 * @param {string} [label='agent'] - Short label embedded in the dir name, for debuggability.
 * @returns {string} Absolute path to the newly created directory.
 */
export function agentDir(label = 'agent') {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const dir = mkdtempSync(join(tmpdir(), `agentwaggle-e2e-${safeLabel}-`));
  createdDirs.add(dir);
  return dir;
}

/**
 * Removes every directory created via {@link agentDir} so far and forgets them.
 * Safe to call even if some directories were already removed.
 * @returns {void}
 */
export function cleanupAgentDirs() {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.clear();
}
