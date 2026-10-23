/**
 * @fileoverview MCP tool definitions exposing Agentwaggle's own chat/agent
 * functionality to an external Claude instance (Claude Code or Claude
 * Desktop, connected over the /mcp endpoint — see mcp/index.js). Every
 * handler here calls the exact same functions the REST routes
 * (routes/chats.js, routes/agents.js) and the WS handler (ws/handler.js)
 * already call — there is no parallel validation/side-effect path to keep
 * in sync; a tool call should behave identically to the same action taken
 * through the UI.
 *
 * Unlike the REST routes (whose caller is always the browser tab that made
 * the request, so a local post-fetch state patch is enough), an MCP caller
 * is never a browser tab at all — without broadcasting, a chat/agent
 * mutation made here would sit invisible in every connected UI until a
 * manual refresh. So every mutating tool here also `broadcast()`s a
 * CHAT_CREATED/CHAT_UPDATED/CHAT_DELETED/AGENT_CREATED/AGENT_UPDATED/
 * AGENT_DELETED event (see app.js's handleServerEvent for the client side).
 */
import { z } from 'zod';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  getChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  addChatMember,
  removeChatMember,
  getAgentChatId,
  getAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  getMessages,
  searchMessages,
} from '../store/db.js';
import { verifyProviderAvailable } from '../services/agentRunner.js';
import { normalizeAutocompact } from '../public/autocompact.js';
import { DEFAULT_PROVIDER_ID, getProvider, providerForAgent } from '../services/providers/index.js';
import { newAgentProvider } from '../services/providerPolicy.js';
import { spawnForAgent, killAgent } from '../services/agentProcessManager.js';
import { handleUserMessage, broadcast, postAgentRemovedNote, postAgentAddedNote } from '../ws/handler.js';
import { t } from '../i18n/t.js';

/** @returns {{ content: [{ type: 'text', text: string }] }} */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** @returns {{ content: [{ type: 'text', text: string }], isError: true }} */
function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Same shape as store/db.js's Attachment typedef. */
const attachmentSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'text']),
  mediaType: z.string().optional(),
  name: z.string().optional(),
  data: z.string(),
  size: z.number().optional(),
});

/**
 * Same normalization as routes/chats.js's private normalizeCategory:
 * undefined stays undefined ("not provided, leave as-is"); null or a
 * blank/whitespace-only string both become null ("uncategorized").
 * @param {unknown} category
 * @returns {string | null | undefined}
 */
function normalizeCategory(category) {
  if (category === undefined) return undefined;
  if (category === null) return null;
  const trimmed = String(category).trim();
  return trimmed || null;
}

/**
 * Same check as routes/chats.js's private crossChatConflictError: an agent
 * belongs to at most one chat at a time, so adding it to a *different* chat
 * than the one it's already in is a conflict that must be resolved (removed
 * from the old one) before it can join the new one.
 * @param {string} agentId
 * @param {string | null} targetChatId
 * @returns {string | null}
 */
function crossChatConflictMessage(agentId, targetChatId) {
  const busyChatId = getAgentChatId(agentId);
  if (!busyChatId || busyChatId === targetChatId) return null;
  const agent = getAgent(agentId);
  const busyChat = getChat(busyChatId);
  return t('errors.agentAlreadyInChat', { name: agent?.name ?? agentId, chatName: busyChat?.name ?? '' });
}

/** Appended to each roster tool's description: what its asAgentId is for. */
const AS_AGENT_HINT = ' Pass asAgentId when acting as one of Agentwaggle\'s agents, so the note this leaves in the chat names that agent instead of "An MCP client".';

/**
 * Who a roster tool's note names as having acted: the agent asAgentId
 * gives, else just "an MCP client" (see RosterActor in ws/handler.js).
 * Only the id is taken, never a name to show: names aren't unique, and a
 * caller-supplied one could disagree with the id. Null when asAgentId names
 * no agent, so the tool can fail before changing anything. Not limited to
 * the chat's own members, unlike send_message's asAgentId: an agent
 * organizing another chat is still the one who acted.
 * @param {string | undefined} asAgentId
 * @returns {import('../ws/handler.js').RosterActor | null}
 */
function rosterActor(asAgentId) {
  if (!asAgentId) return 'mcp';
  return getAgent(asAgentId) ?? null;
}

/**
 * Registers every Agentwaggle-as-tools MCP tool on `mcpServer`.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 * @param {import('ws').WebSocketServer} wss
 */
export function registerTools(mcpServer, wss) {
  mcpServer.registerTool(
    'list_chats',
    { description: 'List every chat: id, name, category, member agent ids, freeRelay/autoContinue flags.' },
    async () => ok(getChats())
  );

  mcpServer.registerTool(
    'get_chat',
    {
      description: "Get one chat's metadata plus its most recent messages.",
      inputSchema: {
        chatId: z.string().describe('Chat UUID'),
        messageLimit: z.number().int().positive().optional().describe('Max recent messages to include (default 20)'),
      },
    },
    async ({ chatId, messageLimit = 20 }) => {
      const chat = getChat(chatId);
      if (!chat) return fail(t('errors.chatNotFound'));
      return ok({ chat, messages: getMessages(chatId, messageLimit) });
    }
  );

  mcpServer.registerTool(
    'search_messages',
    {
      description: "Substring-search a chat's full message history, newest match first.",
      inputSchema: {
        chatId: z.string(),
        query: z.string().min(1),
        limit: z.number().int().positive().optional().describe('Max results (default 30)'),
      },
    },
    async ({ chatId, query, limit = 30 }) => {
      const chat = getChat(chatId);
      if (!chat) return fail(t('errors.chatNotFound'));
      return ok(searchMessages(chatId, query, limit));
    }
  );

  mcpServer.registerTool(
    'create_chat',
    {
      description: 'Create a new chat, optionally with initial agent members. Eagerly spawns each member’s persistent process.',
      inputSchema: {
        name: z.string().min(1),
        memberAgentIds: z.array(z.string()).optional(),
      },
    },
    async ({ name, memberAgentIds = [] }) => {
      for (const agentId of memberAgentIds) {
        const conflict = crossChatConflictMessage(agentId, null);
        if (conflict) return fail(conflict);
      }
      const chat = await createChat({ id: uuidv4(), name, memberAgentIds });
      for (const agentId of memberAgentIds) {
        const agent = getAgent(agentId);
        if (agent) spawnForAgent(agent);
      }
      broadcast(wss, { type: 'CHAT_CREATED', chat });
      return ok(chat);
    }
  );

  mcpServer.registerTool(
    'update_chat',
    {
      description: "Update a chat's name, freeRelay/autoContinue flags, or category.",
      inputSchema: {
        chatId: z.string(),
        name: z.string().optional(),
        freeRelay: z.boolean().optional(),
        autoContinue: z.boolean().optional(),
        category: z.string().nullable().optional().describe('Blank/null clears it (uncategorized)'),
      },
    },
    async ({ chatId, name, freeRelay, autoContinue, category }) => {
      if (name !== undefined && !name.trim()) return fail(t('errors.chatNameRequired'));
      const chat = await updateChat(chatId, { name, freeRelay, autoContinue, category: normalizeCategory(category) });
      if (!chat) return fail(t('errors.chatNotFound'));
      broadcast(wss, { type: 'CHAT_UPDATED', chat });
      return ok(chat);
    }
  );

  mcpServer.registerTool(
    'delete_chat',
    {
      description: "Delete a chat and all its messages. With deleteAgents, also permanently deletes every agent that was a member.",
      inputSchema: {
        chatId: z.string(),
        deleteAgents: z.boolean().optional(),
      },
    },
    async ({ chatId, deleteAgents = false }) => {
      const memberAgentIds = getChat(chatId)?.memberAgentIds ?? [];
      const deleted = await deleteChat(chatId);
      if (!deleted) return fail(t('errors.chatNotFound'));
      // Not awaited: killAgent (by default) waits out any turn a member is
      // still mid-stream on before actually tearing its process down,
      // which could take a while — the chat is already gone from the
      // caller's perspective the moment this returns, and nothing past
      // this point needs the process to have actually exited yet.
      for (const agentId of memberAgentIds) killAgent(agentId).catch(() => {});
      broadcast(wss, { type: 'CHAT_DELETED', chatId });
      if (deleteAgents) {
        await Promise.all(memberAgentIds.map((agentId) => deleteAgent(agentId)));
        for (const agentId of memberAgentIds) broadcast(wss, { type: 'AGENT_DELETED', agentId });
      } else {
        // deleteChat() already cleared each former member's resumeId (see its
        // docs in store/db.js) — surface that, same as a plain removeMember
        // would, so a stale resumeId badge doesn't linger in another tab.
        for (const agentId of memberAgentIds) {
          const agent = getAgent(agentId);
          if (agent) broadcast(wss, { type: 'AGENT_UPDATED', agent });
        }
      }
      return ok({ deleted: true });
    }
  );

  mcpServer.registerTool(
    'add_agent_to_chat',
    {
      description: `Add an existing agent to an existing chat.${AS_AGENT_HINT}`,
      inputSchema: { chatId: z.string(), agentId: z.string(), asAgentId: z.string().optional() },
    },
    async ({ chatId, agentId, asAgentId }) => {
      const actor = rosterActor(asAgentId);
      if (!actor) return fail(t('errors.agentNotFound'));
      const conflict = crossChatConflictMessage(agentId, chatId);
      if (conflict) return fail(conflict);
      const chat = await addChatMember(chatId, agentId);
      if (!chat) return fail(t('errors.chatNotFound'));
      const agent = getAgent(agentId);
      if (agent) spawnForAgent(agent);
      broadcast(wss, { type: 'CHAT_UPDATED', chat });
      if (agent) await postAgentAddedNote(chat, agent, actor, wss);
      return ok(chat);
    }
  );

  mcpServer.registerTool(
    'remove_agent_from_chat',
    {
      description: `Remove an agent from a chat.${AS_AGENT_HINT}`,
      inputSchema: { chatId: z.string(), agentId: z.string(), asAgentId: z.string().optional() },
    },
    async ({ chatId, agentId, asAgentId }) => {
      const actor = rosterActor(asAgentId);
      if (!actor) return fail(t('errors.agentNotFound'));
      const wasMember = getChat(chatId)?.memberAgentIds.includes(agentId) ?? false;
      const chat = await removeChatMember(chatId, agentId);
      if (!chat) return fail(t('errors.chatNotFound'));
      broadcast(wss, { type: 'CHAT_UPDATED', chat });
      if (wasMember) {
        // Not awaited — see delete_chat's comment just above for why: this
        // tool responds (and the agent disappears from the chat) the
        // moment membership is gone, rather than blocking on killAgent's
        // graceful wait for whatever turn this agent might currently be
        // mid-stream on. Reported live: an MCP client removed a teammate
        // via this tool while its reply was still streaming, truncating it
        // and surfacing as an error — this is the fix for that.
        killAgent(agentId).catch(() => {});
        // removeChatMember() already cleared the agent's resumeId — surface
        // that too, same reasoning as delete_chat above.
        const agent = getAgent(agentId);
        if (agent) {
          broadcast(wss, { type: 'AGENT_UPDATED', agent });
          await postAgentRemovedNote(chat, agent, actor, wss);
        }
      }
      return ok(chat);
    }
  );

  mcpServer.registerTool(
    'list_agents',
    { description: 'List every agent: id, name, workingDir, color, flags, model, cost/context usage.' },
    async () => ok(getAgents())
  );

  mcpServer.registerTool(
    'create_agent',
    {
      description: 'Create a new agent (a persistent agent CLI process — claude by default — rooted at workingDir).',
      inputSchema: {
        name: z.string().min(1),
        color: z.string().min(1).describe('Hex color, e.g. "#6B8EAD"'),
        workingDir: z.string().min(1).describe('Absolute path to an existing project directory'),
        provider: z.string().optional().describe(`Which CLI the agent runs as, e.g. "claude", "opencode" or "cursor". Creation-time only. Anything but "${DEFAULT_PROVIDER_ID}" needs multi-provider mode turned on in Settings; unset, the default provider chosen there.`),
        resumeId: z.string().optional().describe("Existing session id to resume, in the provider's own CLI"),
        dangerouslySkipPermissions: z.boolean().optional().describe('YOLO mode'),
        isObserver: z.boolean().optional(),
        chromeAccess: z.boolean().optional(),
        note: z.string().optional(),
        modelOverride: z.string().optional(),
        autocompactOverride: z.string().optional().describe('Context-compaction window: "auto", or 100k–1M tokens (e.g. "200k", "1M"). The Settings default applies when unset.'),
      },
    },
    async ({ name, color, workingDir, provider: requestedProvider, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note, modelOverride, autocompactOverride }) => {
      const allowed = newAgentProvider(requestedProvider);
      if ('error' in allowed) return fail(allowed.error);
      const provider = getProvider(allowed.providerId);
      const normalizedAutocompact = autocompactOverride ? normalizeAutocompact(autocompactOverride) : undefined;
      if (normalizedAutocompact === null) return fail(t('errors.invalidAutocompact'));
      if (!existsSync(workingDir)) return fail(t('errors.agentDirNotFound', { path: workingDir }));
      const verified = await verifyProviderAvailable(provider, { workingDir });
      if (!verified.ok) return fail(t('errors.agentVerifyFailed', { provider: provider.displayName, message: verified.error }));
      const data = { id: uuidv4(), name, color, workingDir, provider: provider.id };
      if (resumeId) data.resumeId = resumeId;
      if (dangerouslySkipPermissions) data.dangerouslySkipPermissions = true;
      if (isObserver) data.isObserver = true;
      if (chromeAccess) data.chromeAccess = true;
      if (note) data.note = note.trim();
      if (modelOverride) data.modelOverride = modelOverride.trim();
      if (normalizedAutocompact) data.autocompactOverride = normalizedAutocompact;
      const agent = await createAgent(data);
      broadcast(wss, { type: 'AGENT_CREATED', agent });
      return ok(agent);
    }
  );

  mcpServer.registerTool(
    'update_agent',
    {
      description: "Update an agent's mutable fields. Changing workingDir/dangerouslySkipPermissions/resumeId/chromeAccess/modelOverride/autocompactOverride evicts its live process — the next turn respawns fresh with the new flags.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        color: z.string().optional(),
        workingDir: z.string().optional(),
        resumeId: z.string().optional(),
        dangerouslySkipPermissions: z.boolean().optional(),
        isObserver: z.boolean().optional(),
        chromeAccess: z.boolean().optional(),
        note: z.string().optional(),
        modelOverride: z.string().optional().describe('Empty string clears it back to "let the CLI decide"'),
        autocompactOverride: z.string().optional().describe('Context-compaction window: "auto", or 100k–1M tokens (e.g. "200k", "1M"). Empty string clears it back to the Settings default.'),
      },
    },
    async ({ agentId, name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note, modelOverride, autocompactOverride }) => {
      const existing = getAgent(agentId);
      if (!existing) return fail(t('errors.agentNotFound'));

      if (workingDir !== undefined && workingDir !== existing.workingDir) {
        if (!existsSync(workingDir)) return fail(t('errors.agentDirNotFound', { path: workingDir }));
        const provider = providerForAgent(existing);
        const verified = await verifyProviderAvailable(provider, { workingDir });
        if (!verified.ok) return fail(t('errors.agentVerifyFailed', { provider: provider.displayName, message: verified.error }));
      }
      const trimmedModelOverride = modelOverride !== undefined ? modelOverride.trim() : undefined;
      const normalizedAutocompact = autocompactOverride === undefined || autocompactOverride.trim() === ''
        ? autocompactOverride?.trim()
        : normalizeAutocompact(autocompactOverride);
      if (normalizedAutocompact === null) return fail(t('errors.invalidAutocompact'));
      const agent = await updateAgent(agentId, {
        name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess,
        note: note !== undefined ? note.trim() : undefined,
        modelOverride: trimmedModelOverride,
        autocompactOverride: normalizedAutocompact,
      });
      if (!agent) return fail(t('errors.agentNotFound'));

      const flagsChanged = (workingDir !== undefined && workingDir !== existing.workingDir)
        || (dangerouslySkipPermissions !== undefined && dangerouslySkipPermissions !== existing.dangerouslySkipPermissions)
        || (resumeId !== undefined && resumeId !== existing.resumeId)
        || (chromeAccess !== undefined && chromeAccess !== existing.chromeAccess)
        || (trimmedModelOverride !== undefined && trimmedModelOverride !== (existing.modelOverride ?? ''))
        || (normalizedAutocompact !== undefined && normalizedAutocompact !== (existing.autocompactOverride ?? ''));
      if (flagsChanged) await killAgent(agentId);
      broadcast(wss, { type: 'AGENT_UPDATED', agent });
      return ok(agent);
    }
  );

  mcpServer.registerTool(
    'delete_agent',
    {
      description: `Delete an agent and all its sessions.${AS_AGENT_HINT}`,
      inputSchema: { agentId: z.string(), asAgentId: z.string().optional() },
    },
    async ({ agentId, asAgentId }) => {
      const actor = rosterActor(asAgentId);
      if (!actor) return fail(t('errors.agentNotFound'));
      const chatId = getAgentChatId(agentId);
      // Both captured before the delete, and the note posted before it too:
      // the agent row, name included, won't exist to read afterward, and
      // the note's agent_id foreign key needs that row to still exist to
      // insert against (messages.agent_id is only ON DELETE SET NULL for
      // rows that already existed at delete time, not a fresh insert
      // against an already-gone id).
      const agent = chatId ? getAgent(agentId) : null;
      const chatBeforeDelete = chatId ? getChat(chatId) : null;
      if (chatBeforeDelete && agent) await postAgentRemovedNote(chatBeforeDelete, agent, actor, wss);
      const deleted = await deleteAgent(agentId);
      if (!deleted) return fail(t('errors.agentNotFound'));
      // Not awaited — same reasoning as remove_agent_from_chat above: this
      // tool responds the moment the agent's DB row is gone, rather than
      // blocking on killAgent's graceful wait for whatever turn it might
      // currently be mid-stream on.
      killAgent(agentId).catch(() => {});
      broadcast(wss, { type: 'AGENT_DELETED', agentId });
      // Deleting an agent cascade-deletes its chat_members row (see the
      // schema's ON DELETE CASCADE) — surface the chat's now-shorter
      // memberAgentIds too, same as remove_agent_from_chat does.
      if (chatId) {
        const chat = getChat(chatId);
        if (chat) broadcast(wss, { type: 'CHAT_UPDATED', chat });
      }
      return ok({ deleted: true });
    }
  );

  mcpServer.registerTool(
    'restart_agent',
    {
      description: "Kill and respawn an agent's live process (e.g. to pick up a newly-authorized MCP connector) without losing chat history — the next turn --resumes.",
      inputSchema: { agentId: z.string() },
    },
    async ({ agentId }) => {
      const agent = getAgent(agentId);
      if (!agent) return fail(t('errors.agentNotFound'));
      await killAgent(agentId);
      spawnForAgent(agent);
      return ok({ restarted: true });
    }
  );

  mcpServer.registerTool(
    'send_message',
    {
      description: 'Post a message into a chat, and wait for and return every agent reply it produces (including any @mention relay chain). Posted as the user unless asAgentId is given, in which case it\'s posted as that agent (a member of the chat) and goes only to the teammates it @mentions. Agents Agentwaggle itself runs don\'t get this tool at all (see buildArgs in services/providers/claude.js): their normal reply already reaches the chat. A busy agent can take a while to reply — there is no timeout here; if a caller\'s own tool-call timeout gives up first, the reply is still saved and visible via a follow-up get_chat/search_messages call.',
      inputSchema: {
        chatId: z.string(),
        content: z.string().min(1),
        attachments: z.array(attachmentSchema).optional(),
        asAgentId: z.string().optional(),
      },
    },
    async ({ chatId, content, attachments = [], asAgentId }) => {
      const chat = getChat(chatId);
      if (!chat) return fail(t('errors.chatNotFound'));
      if (asAgentId) {
        const agent = getAgent(asAgentId);
        if (!agent) return fail(t('errors.agentNotFound'));
        if (!chat.memberAgentIds.includes(asAgentId)) return fail(t('errors.agentNotInChat', { name: agent.name }));
      }
      const { userMessage, replies } = await handleUserMessage({ chatId, content, attachments, asAgentId }, wss);
      return ok({ userMessage, replies });
    }
  );
}
