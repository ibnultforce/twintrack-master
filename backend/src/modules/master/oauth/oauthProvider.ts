import { randomBytes, randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { hashRandomToken } from '../auth/tokens.js';
import type { OAuthAuthorizationRequestDoc, OAuthGrantDoc } from '../models/oauth.js';
import { findUserById } from '../users/users.repository.js';
import {
  consumeAuthorizationCode,
  findAuthorizationRequestByCode,
  findGrantByAccessToken,
  findGrantByRefreshToken,
  findOAuthClient,
  insertAuthorizationRequest,
  insertGrant,
  insertOAuthClient,
  revokeGrantByToken,
  revokeGrantsFromRequest,
  rotateGrantTokens,
} from './oauth.repository.js';

export const OAUTH_ACCESS_TOKEN_PREFIX = 'tt_oat_';
const REFRESH_TOKEN_PREFIX = 'tt_ort_';
const TOKEN_BYTES = 32;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
/** Long enough to sign in on the consent page first. Codes work once anyway. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000;
export const CONSENT_PAGE_PATH = '/oauth/consent';

/** Where things live: this API, which issues the tokens, and the portal, which asks for consent. */
export interface OAuthSettings {
  publicApiUrl: string;
  portalUrl: string;
}

export const oauthBaseUrl = (settings: OAuthSettings) => `${settings.publicApiUrl}/oauth`;
export const mcpResourceUrl = (settings: OAuthSettings) => `${settings.publicApiUrl}/mcp`;

export function buildOAuthMetadata(settings: OAuthSettings): OAuthMetadata {
  const base = oauthBaseUrl(settings);
  return {
    issuer: new URL(settings.publicApiUrl).href,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  };
}

const newToken = (prefix: string) => prefix + randomBytes(TOKEN_BYTES).toString('base64url');

function tokenResponse(accessToken: string, refreshToken: string, scopes: string[]): OAuthTokens {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refreshToken,
    ...(scopes.length > 0 && { scope: scopes.join(' ') }),
  };
}

function newTokenPair() {
  const accessToken = newToken(OAUTH_ACCESS_TOKEN_PREFIX);
  const refreshToken = newToken(REFRESH_TOKEN_PREFIX);
  const stored = {
    accessTokenHash: hashRandomToken(accessToken),
    accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshTokenHash: hashRandomToken(refreshToken),
    refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
  return { accessToken, refreshToken, stored };
}

const isUserActive = async (userId: string) => (await findUserById(userId))?.status === 'active';

/** A grant whose access token still works, for someone still active. */
export async function findUsableGrant(accessToken: string): Promise<OAuthGrantDoc | null> {
  if (!accessToken.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
  const grant = await findGrantByAccessToken(hashRandomToken(accessToken));
  if (!grant || grant.revokedAt || grant.accessTokenExpiresAt <= new Date()) return null;
  return (await isUserActive(grant.userId)) ? grant : null;
}

/**
 * The storage behind the OAuth 2.1 endpoints, whose protocol handling (PKCE, redirect checks, error formats) is the
 * MCP SDK's. Tokens act as the person who approved them, with exactly their access, like a personal API token.
 */
export function createOAuthProvider(settings: OAuthSettings, cipher: SecretCipher): OAuthServerProvider {
  /** The resource an app asks for must be this API's MCP endpoint. Some apps send the bare address instead. */
  function assertOurResource(resource: URL | string | undefined) {
    if (!resource) return;
    const href = new URL(String(resource)).href.replace(/\/+$/, '');
    if (href !== mcpResourceUrl(settings) && href !== settings.publicApiUrl) throw new InvalidTargetError(`Unknown resource: ${href}`);
  }

  /** An approved, unexpired code for this app. */
  async function findRedeemableCode(client: OAuthClientInformationFull, code: string): Promise<OAuthAuthorizationRequestDoc & { userId: string }> {
    const request = await findAuthorizationRequestByCode(hashRandomToken(code));
    if (!request?.userId || request.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (request.expiresAt <= new Date()) throw new InvalidGrantError('Authorization code expired');
    return { ...request, userId: request.userId };
  }

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      const client = await findOAuthClient(clientId);
      if (!client) return undefined;
      return {
        ...client.metadata,
        client_id: client._id,
        ...(client.clientSecretEncrypted && { client_secret: cipher.decrypt(client.clientSecretEncrypted) }),
      } as OAuthClientInformationFull;
    },
    async registerClient(information) {
      const { client_secret: clientSecret, ...metadata } = information as OAuthClientInformationFull;
      await insertOAuthClient({ _id: metadata.client_id, metadata, ...(clientSecret && { clientSecretEncrypted: cipher.encrypt(clientSecret) }) });
      return information as OAuthClientInformationFull;
    },
  };

  return {
    get clientsStore() {
      return clientsStore;
    },

    /** The SDK has checked the app and its redirect. The person's browser goes to the portal to approve or decline. */
    async authorize(client, params, res) {
      assertOurResource(params.resource);
      const requestId = randomUUID();
      await insertAuthorizationRequest({
        _id: requestId,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.href,
        expiresAt: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
      });
      res.redirect(302, `${settings.portalUrl}${CONSENT_PAGE_PATH}?request=${requestId}`);
    },

    async challengeForAuthorizationCode(client, code) {
      return (await findRedeemableCode(client, code)).codeChallenge;
    },

    /** The SDK checked PKCE already. A code used twice may have leaked, so whatever it gave is revoked too. */
    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
      const request = await findRedeemableCode(client, code);
      if (redirectUri !== undefined && redirectUri !== request.redirectUri) {
        throw new InvalidGrantError('redirect_uri does not match the authorization request');
      }
      assertOurResource(resource);

      if (!(await consumeAuthorizationCode(request._id))) {
        await revokeGrantsFromRequest(request._id);
        throw new InvalidGrantError('Authorization code already used');
      }
      if (!(await isUserActive(request.userId))) throw new InvalidGrantError('User is no longer active');

      const { accessToken, refreshToken, stored } = newTokenPair();
      await insertGrant({
        _id: `og_${randomUUID()}`,
        clientId: client.client_id,
        userId: request.userId,
        authorizationRequestId: request._id,
        scopes: request.scopes,
        resource: request.resource ?? resource?.href,
        ...stored,
      });
      return tokenResponse(accessToken, refreshToken, request.scopes);
    },

    /** Replaces both tokens, so the refresh token presented stops working at once. */
    async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
      assertOurResource(resource);
      const presentedHash = hashRandomToken(refreshToken);
      const grant = await findGrantByRefreshToken(presentedHash);
      if (!grant || grant.clientId !== client.client_id || grant.revokedAt || grant.refreshTokenExpiresAt <= new Date()) {
        throw new InvalidGrantError('Invalid refresh token');
      }
      if (!(await isUserActive(grant.userId))) throw new InvalidGrantError('User is no longer active');

      const next = newTokenPair();
      if (!(await rotateGrantTokens(grant._id, presentedHash, next.stored))) throw new InvalidGrantError('Invalid refresh token');
      return tokenResponse(next.accessToken, next.refreshToken, grant.scopes);
    },

    async verifyAccessToken(token): Promise<AuthInfo> {
      const grant = await findUsableGrant(token);
      if (!grant) throw new InvalidTokenError('Invalid or expired access token');
      return {
        token,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: Math.floor(grant.accessTokenExpiresAt.getTime() / 1000),
        ...(grant.resource && { resource: new URL(grant.resource) }),
      };
    },

    /** Revoking either token ends the whole connection (RFC 7009). An unknown token is not an error. */
    async revokeToken(client, { token }) {
      await revokeGrantByToken(client.client_id, hashRandomToken(token));
    },
  };
}
