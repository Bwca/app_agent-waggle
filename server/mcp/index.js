/**
 * @fileoverview Mounts the MCP server (see mcp/server.js/tools.js) onto the
 * main Express app at /mcp — lets an external Claude instance (Claude Code
 * or Claude Desktop, both running on this same machine) drive Agentwaggle
 * itself: create/manage chats and agents, send a message and get the
 * replies back. Off by default — see isMcpEnabled.
 */
import { isMcpEnabled, requireMcpToken } from './auth.js';
import { handleMcpRequest } from './server.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'mcp' });

/**
 * Mounts POST/GET/DELETE /mcp on `app` if MCP_AUTH_TOKEN is set; otherwise
 * logs how to enable it and mounts nothing (the route simply won't exist —
 * a request to it 404s from Express's default handler, not a 401, so
 * "disabled" and "wrong token" are clearly distinguishable states).
 * @param {import('express').Express} app
 * @param {import('ws').WebSocketServer} wss
 */
export function mountMcp(app, wss) {
  if (!isMcpEnabled()) {
    log.warn(
      'MCP server disabled — set MCP_AUTH_TOKEN to enable /mcp (e.g. `export MCP_AUTH_TOKEN=$(openssl rand -hex 32)`)'
    );
    return;
  }
  // One handler for every method: the transport itself replies 405 to
  // GET/DELETE in this stateless configuration (see server.js), so there's
  // no need to special-case them here.
  app.all('/mcp', requireMcpToken, (req, res) => handleMcpRequest(req, res, wss));
  log.info('MCP server mounted at /mcp');
}
