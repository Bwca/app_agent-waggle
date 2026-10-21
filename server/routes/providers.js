/**
 * @fileoverview REST route reporting which agent providers can actually run
 * here, so the New Agent form only offers a CLI that's installed instead of
 * failing on Create. Mounted at /api/providers.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { listProviders } from '../services/providers/index.js';
import { verifyProviderAvailable } from '../services/agentRunner.js';

const router = Router();

/**
 * @typedef {Object} ProviderAvailability
 * @property {string} id
 * @property {boolean} available - Its binary ran `--version` successfully.
 * @property {import('../services/providers/index.js').BinarySource} source -
 *   Where the binary was (or would have been) taken from.
 * @property {string} [version] - The binary's own version line, when available.
 * @property {string} [error] - Why it couldn't run, when not.
 */

/**
 * GET /api/providers?workingDir=<path>
 * Checks every provider's binary the same way creating an agent does (see
 * verifyProviderAvailable), in parallel. `workingDir` is the agent-to-be's
 * project, for a provider that can use a copy pinned there; ignored if it
 * doesn't exist. The same check still runs on Create, so this is advice
 * for the form, not a guarantee.
 * @returns {ProviderAvailability[]} In registry order.
 */
router.get('/', async (req, res) => {
  const workingDir = typeof req.query.workingDir === 'string' && existsSync(req.query.workingDir)
    ? req.query.workingDir
    : undefined;
  const results = await Promise.all(listProviders().map(async (provider) => {
    const result = await verifyProviderAvailable(provider, workingDir ? { workingDir } : undefined);
    return result.ok
      ? { id: provider.id, available: true, source: result.source, version: result.version }
      : { id: provider.id, available: false, source: result.source, error: result.error };
  }));
  res.json(results);
});

export default router;
