/**
 * @fileoverview Auth gate for the /mcp endpoint (see mcp/index.js). Agentwaggle
 * has no authentication anywhere else — its only existing security boundary
 * is binding to 127.0.0.1 (server/index.js) — but /mcp is the first
 * network-reachable surface that can drive real tool-executing agents, so it
 * gets its own token check on top of that bind. This is defense-in-depth,
 * not a real boundary against a remote attacker: anyone who can already
 * reach loopback on this host could read MCP_AUTH_TOKEN out of the
 * process's own env anyway. Its actual job is stopping some *other*
 * unrelated local process/browser tab from silently driving Agentwaggle.
 */
import { timingSafeEqual } from 'crypto';

/**
 * Whether the MCP server should be mounted at all — gated on MCP_AUTH_TOKEN
 * being set, so the endpoint defaults to not existing rather than existing
 * unauthenticated. See mountMcp (mcp/index.js) for the caller.
 * @returns {boolean}
 */
export function isMcpEnabled() {
  return Boolean(process.env.MCP_AUTH_TOKEN);
}

/**
 * Constant-time string comparison — timingSafeEqual itself throws on
 * mismatched lengths rather than returning false, so the length check has
 * to happen first (and itself leaks only length, not content).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Extracts the presented token from either an `Authorization: Bearer <token>`
 * header or a `?token=` query param — accepting both is deliberate: Claude
 * Code's `claude mcp add --header` can send the header form, but Claude
 * Desktop's custom-connector setup only takes a URL with no header field, so
 * the token has to also work embedded in that URL.
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function extractToken(req) {
  const authHeader = req.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice('Bearer '.length);
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

/**
 * Express middleware gating every /mcp request behind MCP_AUTH_TOKEN.
 * Responds with a JSON-RPC-shaped 401 (not a bare Express error page) on
 * failure, since a compliant MCP client parses the response body as JSON-RPC.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireMcpToken(req, res, next) {
  const expected = process.env.MCP_AUTH_TOKEN;
  const presented = extractToken(req);
  if (!expected || !presented || !safeEqual(presented, expected)) {
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized: missing or invalid MCP token' },
    });
  }
  next();
}
