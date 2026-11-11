import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { ApiError } from '../../../lib/errors.js';
import { findProfileOf } from '../accessProfiles/accessProfiles.repository.js';
import { isApiToken, resolveApiToken } from '../apiTokens/apiTokens.service.js';
import { MongoRateLimitStore } from '../auth/rateLimitStore.js';
import { isOAuthAccessToken, resolveOAuthAccessToken } from '../oauth/oauth.service.js';
import { mcpResourceUrl, type OAuthSettings } from '../oauth/oauthProvider.js';
import type { McpCaller, McpToolProvider } from './mcpTools.js';

const BEARER_PREFIX = 'Bearer ';
const SERVER_VERSION = '1.0.0';
const CALLS_PER_MINUTE = 120;

const instructions =
  'TwinTrack is TwinForce\'s internal portal. Every tool acts as the signed-in person, with exactly their access. ' +
  'Start with whoami to see which modules they can use.';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the MCP token check. */
    mcpCaller?: McpCaller;
  }
}

/**
 * Accepts a personal API token (for Claude Code) or an OAuth access token (for claude.ai connectors). Without one, the
 * answer names where to find the sign-in flow (RFC 9728), which is how an app knows to start OAuth.
 */
function createMcpTokenCheck(settings: OAuthSettings): RequestHandler {
  const resourceMetadataUrl = `${settings.publicApiUrl}/.well-known/oauth-protected-resource${new URL(mcpResourceUrl(settings)).pathname}`;
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"`;

  return async (req, res, next) => {
    const header = req.get('Authorization');
    const presented = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : '';
    if (!presented) {
      res.set('WWW-Authenticate', challenge);
      throw new ApiError(401, 'no_token', 'Send a TwinTrack API token or OAuth access token.');
    }

    let user = null;
    if (isApiToken(presented)) user = await resolveApiToken(presented);
    else if (isOAuthAccessToken(presented)) user = await resolveOAuthAccessToken(presented);
    if (!user) {
      res.set('WWW-Authenticate', `${challenge}, error="invalid_token"`);
      throw new ApiError(401, 'invalid_token', 'This token is invalid, expired or revoked.');
    }

    req.mcpCaller = { user, profile: await findProfileOf(user) };
    next();
  };
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ error: { code: 'method_not_allowed', message: 'The MCP endpoint takes POST only.' } });
};

/**
 * The MCP endpoint for AI apps. Stateless: each call gets a fresh server bound to its token's person, so nothing is
 * shared between calls or people, and every call checks the token again.
 */
export function createMcpRoutes(settings: OAuthSettings, toolProviders: McpToolProvider[]): ApiRoute[] {
  // Any origin may call: app.ts gives this path open CORS, because apps send bearer tokens, never cookies.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: CALLS_PER_MINUTE,
    store: new MongoRateLimitStore('mcp'),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'too_many_requests', message: 'Too many MCP calls. Try again in a minute.' } },
  });

  const handleCall: RequestHandler = async (req, res) => {
    const caller = req.mcpCaller;
    if (!caller) throw new Error('The MCP route ran without its token check.');

    const server = new McpServer({ name: 'twintrack', version: SERVER_VERSION }, { instructions });
    for (const addTools of toolProviders) addTools(server, caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // Public in the access model, because these check their own tokens rather than a session.
  return [
    { method: 'POST', path: '/mcp', access: 'public', middleware: [limiter, createMcpTokenCheck(settings)], handler: handleCall },
    { method: 'GET', path: '/mcp', access: 'public', handler: methodNotAllowed },
    { method: 'DELETE', path: '/mcp', access: 'public', handler: methodNotAllowed },
  ];
}
