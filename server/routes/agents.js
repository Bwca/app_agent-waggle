/**
 * @fileoverview REST routes for agent CRUD operations.
 * Mounted at /api/agents. A factory (not a plain router) because DELETE
 * /:id needs `wss` to post a system note into any chat the agent was a
 * member of — see postAgentRemovedNote in ws/handler.js.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getAgents, getAgent, getAgentChatId, getChat, createAgent, updateAgent, deleteAgent } from '../store/db.js';
import { verifyProviderAvailable } from '../services/agentRunner.js';
import { providerForAgent } from '../services/providers/index.js';
import { killAgent, getAgentSkills, spawnForAgent } from '../services/agentProcessManager.js';
import { listAgentCommands, mergeSkills } from '../services/commands.js';
import { postAgentRemovedNote } from '../ws/handler.js';
import { normalizeAutocompact } from '../public/autocompact.js';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'routes:agents' });

/**
 * @param {import('ws').WebSocketServer} wss
 * @returns {import('express').Router}
 */
export default function createAgentsRouter(wss) {
  const router = Router();

  /** The OS command that opens a path in the native file manager. */
  const OPEN_FOLDER_CMD = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';

  /**
   * GET /api/agents
   * Returns all agents.
   */
  router.get('/', (_req, res) => {
    res.json(getAgents());
  });

  /**
   * GET /api/agents/:id
   * Returns a single agent by ID.
   */
  router.get('/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
    res.json(agent);
  });

  /**
   * POST /api/agents
   * Creates a new agent.
   * @param {Object} req.body
   * @param {string} req.body.name - Agent display name
   * @param {string} req.body.color - Hex color e.g. "#6B8EAD"
   * @param {string} req.body.workingDir - Absolute path to project directory
   * @param {string} [req.body.resumeId] - Optional claude --resume conversation ID
   * @param {boolean} [req.body.dangerouslySkipPermissions] - "YOLO mode", opt-in
   * @param {boolean} [req.body.isObserver] - Observer mode, opt-in (creation-time only in the UI)
   * @param {boolean} [req.body.chromeAccess] - Browser access via the Claude in
   *   Chrome extension, opt-in (creation-time only in the UI). Multiple agents
   *   may hold this concurrently — the extension's local bridge (ws://localhost:8765)
   *   scopes each connecting CLI process to its own tab group, so concurrent
   *   `--chrome` sessions don't steal each other's pairing.
   * @param {string} [req.body.note] - Freeform note for the user's own
   *   reference (why this agent exists) — never sent to the CLI.
   * @param {string} [req.body.modelOverride] - Model to pass as `--model`
   *   (an alias like "opus"/"sonnet"/"fable", or a full model ID) — the CLI
   *   decides on its own when unset.
   * @param {string} [req.body.autocompactOverride] - This agent's own
   *   context-compaction window (see normalizeAutocompact); the Settings
   *   default applies when unset.
   */
  router.post('/', async (req, res) => {
    const { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note, modelOverride, autocompactOverride } = req.body;
    if (!name || !color || !workingDir) {
      return res.status(400).json({ error: t('errors.agentFieldsRequired') });
    }
    const normalizedAutocompact = autocompactOverride ? normalizeAutocompact(autocompactOverride) : undefined;
    if (normalizedAutocompact === null) {
      return res.status(400).json({ error: t('errors.invalidAutocompact') });
    }
    if (!existsSync(workingDir)) {
      return res.status(400).json({ error: t('errors.agentDirNotFound', { path: workingDir }) });
    }
    const verified = await verifyProviderAvailable();
    if (!verified.ok) {
      return res.status(400).json({ error: t('errors.agentVerifyFailed', { message: verified.error }) });
    }
    const data = { id: uuidv4(), name, color, workingDir };
    if (resumeId) data.resumeId = resumeId;
    if (dangerouslySkipPermissions) data.dangerouslySkipPermissions = true;
    if (isObserver) data.isObserver = true;
    if (chromeAccess) data.chromeAccess = true;
    if (note) data.note = note.trim();
    if (modelOverride) data.modelOverride = modelOverride.trim();
    if (normalizedAutocompact) data.autocompactOverride = normalizedAutocompact;
    const agent = await createAgent(data);
    res.status(201).json(agent);
  });

  /**
   * PATCH /api/agents/:id
   * Updates an agent's mutable fields.
   * @param {Object} req.body
   * @param {string} [req.body.name]
   * @param {string} [req.body.color]
   * @param {string} [req.body.workingDir]
   * @param {string} [req.body.resumeId]
   * @param {boolean} [req.body.dangerouslySkipPermissions]
   * @param {boolean} [req.body.isObserver] - Not exposed in the UI for editing,
   *   but supported generically here. Pure server-side routing/context logic —
   *   unlike workingDir/dangerouslySkipPermissions/resumeId, it is NOT baked
   *   into the CLI's spawn args, so changing it does NOT evict the running
   *   process (see flagsChanged below, which deliberately omits it).
   * @param {boolean} [req.body.chromeAccess] - Not exposed in the UI for
   *   editing, but supported generically here. Baked into spawn args
   *   (--chrome), so turning it on evicts the running process like
   *   dangerouslySkipPermissions does.
   * @param {string} [req.body.note] - Freeform note for the user's own
   *   reference. IS exposed in the UI for editing — purely metadata, never
   *   baked into spawn args, so changing it never evicts the running process.
   * @param {string} [req.body.modelOverride] - IS exposed in the UI for
   *   editing (the "switch model" agent-menu action) — an empty string clears
   *   it back to "let the CLI decide". Baked into spawn args (--model), so
   *   changing it evicts the running process like workingDir/resumeId/
   *   chromeAccess — confirmed empirically that --model paired with --resume
   *   switches an existing session's model without losing its history, so
   *   this is a genuine live switch, not a fresh conversation.
   * @param {string} [req.body.autocompactOverride] - IS exposed in the UI
   *   (the agent menu's compaction-window action), and can change any time
   *   in the agent's life; an empty string clears it back to the Settings
   *   default. Baked into spawn args (--autocompact), so a change evicts the
   *   running process like modelOverride, and the next turn resumes the
   *   same session with the new window.
   */
  router.patch('/:id', async (req, res) => {
    const { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note, modelOverride, autocompactOverride } = req.body;
    const existing = getAgent(req.params.id);
    if (!existing) return res.status(404).json({ error: t('errors.agentNotFound') });

    // Only re-verify if workingDir is actually changing — resumeId isn't
    // checked at all (see verifyProviderAvailable's docs), and renaming or
    // recoloring an already-working agent shouldn't touch the filesystem.
    if (workingDir !== undefined && workingDir !== existing.workingDir) {
      if (!existsSync(workingDir)) {
        return res.status(400).json({ error: t('errors.agentDirNotFound', { path: workingDir }) });
      }
      const verified = await verifyProviderAvailable(providerForAgent(existing));
      if (!verified.ok) {
        return res.status(400).json({ error: t('errors.agentVerifyFailed', { message: verified.error }) });
      }
    }
    // Trimmed once, reused for both the write below and the flagsChanged
    // comparison — an empty string is a deliberate "clear the override", same
    // convention as note.
    const trimmedModelOverride = modelOverride !== undefined ? modelOverride.trim() : undefined;
    // '' clears the override, same convention as modelOverride.
    const normalizedAutocompact = autocompactOverride === undefined || autocompactOverride.trim() === ''
      ? autocompactOverride?.trim()
      : normalizeAutocompact(autocompactOverride);
    if (normalizedAutocompact === null) {
      return res.status(400).json({ error: t('errors.invalidAutocompact') });
    }
    const agent = await updateAgent(req.params.id, { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note: note !== undefined ? note.trim() : undefined, modelOverride: trimmedModelOverride, autocompactOverride: normalizedAutocompact });
    if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
    // workingDir/dangerouslySkipPermissions/resumeId/chromeAccess/modelOverride
    // are all baked into the agent's persistent process at spawn time
    // (--add-dir, --dangerously-skip-permissions, --resume, --chrome,
    // --model) — a running process has no way to pick up a change to any of
    // them, so evict it; the next turn respawns fresh. workingDir/
    // dangerouslySkipPermissions/resumeId/chromeAccess aren't reachable from
    // the UI yet (though this is live API surface) — modelOverride is, via
    // the "switch model" agent-menu action.
    const flagsChanged = (workingDir !== undefined && workingDir !== existing.workingDir)
      || (dangerouslySkipPermissions !== undefined && dangerouslySkipPermissions !== existing.dangerouslySkipPermissions)
      || (resumeId !== undefined && resumeId !== existing.resumeId)
      || (chromeAccess !== undefined && chromeAccess !== existing.chromeAccess)
      || (trimmedModelOverride !== undefined && trimmedModelOverride !== (existing.modelOverride ?? ''))
      || (normalizedAutocompact !== undefined && normalizedAutocompact !== (existing.autocompactOverride ?? ''));
    if (flagsChanged) await killAgent(req.params.id);
    res.json(agent);
  });

  /**
   * POST /api/agents/:id/open-folder
   * Opens the agent's working directory in the OS's native file manager.
   */
  router.post('/:id/open-folder', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });

    const child = spawn(OPEN_FOLDER_CMD, [agent.workingDir], { stdio: 'ignore', detached: true });
    child.on('error', (err) => log.error({ agentId: agent.id, err }, 'failed to open folder'));
    child.unref();

    res.json({ ok: true });
  });

  /**
   * POST /api/agents/:id/restart
   * Kills the agent's live process, if any — the next turn spawns a fresh one
   * and `--resume`s, so no chat history is lost. Some process state (notably
   * which MCP connectors/servers are authorized) is read fresh only once, at
   * spawn time, and never re-read for that process's lifetime — see
   * providers/claude.js's looksLikeMcpAuthFailure docs. This gives a way to
   * pick up such changes (e.g. a connector authorized mid-session) for one
   * agent without restarting the whole server.
   */
  router.post('/:id/restart', async (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
    await killAgent(agent.id);
    spawnForAgent(agent);
    res.json({ ok: true });
  });

  /**
   * GET /api/agents/:id/commands
   * Lists the agent's slash commands for the composer's "/" autocomplete:
   * its project-level custom commands (.claude/commands/*.md in its
   * workingDir) merged with the built-in/marketplace/plugin skills its own
   * live process actually reported having (empty until that process has
   * spawned at least once — see getAgentSkills).
   */
  router.get('/:id/commands', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
    res.json(mergeSkills(listAgentCommands(agent.workingDir), getAgentSkills(agent.id)));
  });

  /**
   * DELETE /api/agents/:id
   * Deletes an agent and all its sessions. If it was a member of a chat,
   * posts a system note there recording the removal (see
   * postAgentRemovedNote) — BEFORE the actual delete, since the note's
   * agent_id foreign key needs the agent row to still exist to insert
   * against (messages.agent_id is only ON DELETE SET NULL for rows that
   * already existed at delete time, not for a fresh insert against an
   * already-gone id).
   */
  router.delete('/:id', async (req, res) => {
    const chatId = getAgentChatId(req.params.id);
    const agent = chatId ? getAgent(req.params.id) : null;
    const chat = chatId ? getChat(chatId) : null;
    if (chat && agent) await postAgentRemovedNote(chat, agent, 'user', wss);
    const deleted = await deleteAgent(req.params.id);
    if (!deleted) return res.status(404).json({ error: t('errors.agentNotFound') });
    // Not awaited: killAgent (by default) waits out any turn this agent is
    // still mid-stream on before actually tearing its process down, which
    // could take a while — the agent is already gone from the caller's
    // perspective (and the DB) the moment this responds, unlike
    // POST /:id/restart above, which genuinely needs the old process gone
    // before spawnForAgent runs or it'd just no-op against the still-alive
    // one.
    killAgent(req.params.id).catch(() => {});
    res.status(204).end();
  });

  return router;
}
