/**
 * @fileoverview REST route reporting which agent providers can actually run
 * here, so the New Agent form only offers a CLI that's installed instead of
 * failing on Create. Mounted at /api/providers.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { getProvider, hasProvider, listProviders } from '../services/providers/index.js';
import { listProviderModels, verifyProviderAvailable } from '../services/agentRunner.js';

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
  const workingDir = existingDir(req.query.workingDir);
  const results = await Promise.all(listProviders().map(async (provider) => {
    const result = await verifyProviderAvailable(provider, workingDir ? { workingDir } : undefined);
    return result.ok
      ? { id: provider.id, available: true, source: result.source, version: result.version }
      : { id: provider.id, available: false, source: result.source, error: result.error };
  }));
  res.json(results);
});

/**
 * GET /api/providers/:id/models?workingDir=<path>
 * The model IDs that provider can run, for the model picker (see
 * listProviderModels). `workingDir` as for GET /api/providers, since a
 * project can configure its own models.
 * @returns {{ models: string[] }} 404 for an unknown provider or one with no
 *   model list, 502 when listing failed.
 */
router.get('/:id/models', async (req, res) => {
  if (!hasProvider(req.params.id)) return res.status(404).json({ error: `Unknown agent provider: ${req.params.id}` });
  const provider = getProvider(req.params.id);
  if (!provider.modelsCommand) return res.status(404).json({ error: `${provider.displayName} has no model list` });
  const workingDir = existingDir(req.query.workingDir);
  const result = await listProviderModels(provider, workingDir ? { workingDir } : undefined);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ models: result.models });
});

/**
 * @param {unknown} value - A `workingDir` query parameter.
 * @returns {string | undefined} It, if it names a path that exists.
 */
function existingDir(value) {
  return typeof value === 'string' && existsSync(value) ? value : undefined;
}

export default router;
