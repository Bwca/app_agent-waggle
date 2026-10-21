/**
 * @fileoverview Per-request MCP server/transport construction — see
 * mcp/index.js for where this is mounted and mcp/tools.js for the tool set.
 *
 * Stateless by design (`sessionIdGenerator: undefined`): every tool call is
 * an independent request/response with no server-initiated push, so there's
 * no reason to hold a session-id -> transport map alive between requests.
 * The Streamable HTTP spec's stateless mode requires a FRESH transport (and,
 * since tool registration is cheap, a fresh McpServer) per request — reusing
 * one across requests is explicitly unsupported by the SDK in this mode.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { APP_VERSION } from '../public/appVersion.js';

/**
 * Builds one fresh McpServer with every Agentwaggle tool registered.
 * @param {import('ws').WebSocketServer} wss
 * @returns {McpServer}
 */
function createMcpServer(wss) {
  const mcpServer = new McpServer({ name: 'agentwaggle', version: APP_VERSION });
  registerTools(mcpServer, wss);
  return mcpServer;
}

/**
 * Express handler for POST/GET/DELETE /mcp — builds a fresh server+transport
 * pair, connects them, and hands off the raw request. `enableJsonResponse`
 * is set since every call here is a plain request/response with no
 * server-push need, so a client that only accepts `application/json` (not
 * `text/event-stream`) still works without any extra client-side setup.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('ws').WebSocketServer} wss
 */
export async function handleMcpRequest(req, res, wss) {
  const mcpServer = createMcpServer(wss);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
