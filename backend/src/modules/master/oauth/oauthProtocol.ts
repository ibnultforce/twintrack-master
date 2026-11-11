import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Application, RequestHandler } from 'express';
import { buildOAuthMetadata, mcpResourceUrl, type OAuthSettings } from './oauthProvider.js';

/**
 * The OAuth protocol endpoints and discovery documents, which come from the MCP SDK as mounted routers. They are the
 * one allowed exception to registering routes directly: the SDK owns their validation, PKCE checks, error format, CORS
 * and rate limits, and the Postman coverage test knows them from this set.
 */
export const oauthProtocolHandlers = new WeakSet<object>();

/** Paths these handlers answer, which take requests from any origin because their callers are apps, not the portal. */
export const OAUTH_PROTOCOL_PATH = /^\/(oauth\/(authorize|token|register|revoke)|\.well-known\/)/;

const protocolHandler = (handler: RequestHandler) => {
  oauthProtocolHandlers.add(handler);
  return handler;
};

export function mountOAuthProtocol(app: Application, provider: OAuthServerProvider, settings: OAuthSettings): void {
  app.use('/oauth/authorize', protocolHandler(authorizationHandler({ provider })));
  app.use('/oauth/token', protocolHandler(tokenHandler({ provider })));
  // A connector's registration shouldn't quietly expire. People disconnect an app by revoking it instead.
  app.use('/oauth/register', protocolHandler(clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 })));
  app.use('/oauth/revoke', protocolHandler(revocationHandler({ provider })));
  // RFC 8414 and RFC 9728, which an app reads before anything else. The SDK refuses a plain-http issuer except localhost.
  app.use(protocolHandler(mcpAuthMetadataRouter({ oauthMetadata: buildOAuthMetadata(settings), resourceServerUrl: new URL(mcpResourceUrl(settings)), resourceName: 'TwinTrack' })));
}
