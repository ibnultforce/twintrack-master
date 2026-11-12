import { randomBytes } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { findPermissionsIn } from '../access/access.service.js';
import { assertNotImpersonating, type Actor, type Caller } from '../access/caller.js';
import { findTokenOwnerReach, ownerReachCondition, reachesOwner } from '../apiTokens/tokenOwnerReach.js';
import { recordAudit } from '../audit/audit.repository.js';
import { hashRandomToken } from '../auth/tokens.js';
import type { OAuthClientDoc, OAuthGrantDoc } from '../models/oauth.js';
import type { UserDoc } from '../models/user.js';
import { MASTER_MODULE_KEY, type Scope } from '../moduleRegistry/manifest.js';
import { findUserById, findUsersByIds } from '../users/users.repository.js';
import {
  findAuthorizationRequest,
  findGrantById,
  findGrantOf,
  findLiveGrantPage,
  findLiveGrantsOf,
  findOAuthClient,
  findOAuthClientsByIds,
  markGrantRevoked,
  recordAuthorizationDecision,
  recordGrantUsed,
} from './oauth.repository.js';
import { findUsableGrant, OAUTH_ACCESS_TOKEN_PREFIX } from './oauthProvider.js';

const CODE_BYTES = 32;
/** Connecting an app gives it a credential that acts as the person, like making an API token. */
const CONNECT_APP_PERMISSION = 'apiToken.create';
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Apps name themselves when they register, so this is a claim, shown next to where the browser goes next. */
function clientNameOf(client: Pick<OAuthClientDoc, 'metadata'> | null | undefined): string {
  const name = client?.metadata.client_name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Unnamed app';
}

async function requirePendingRequest(requestId: string) {
  const request = await findAuthorizationRequest(requestId);
  if (!request) throw new ApiError(404, 'unknown_request', 'This sign-in request does not exist.');
  if (request.decidedAt) throw new ApiError(409, 'request_answered', 'This sign-in request has already been answered.');
  if (request.expiresAt <= new Date()) throw new ApiError(409, 'request_expired', 'This sign-in request has expired. Start again from the app.');
  return request;
}

/** What the consent page shows: which app asks, and where the browser will be sent, which the app can't fake. */
export async function getAuthorizationRequest(requestId: string) {
  const request = await requirePendingRequest(requestId);
  return {
    id: request._id,
    clientName: clientNameOf(await findOAuthClient(request.clientId)),
    redirectHost: new URL(request.redirectUri).host,
    expiresAt: request.expiresAt,
  };
}

/** Records the person's answer, and returns where to send their browser: back to the app, with a code or a refusal. */
export async function decideAuthorizationRequest(caller: Caller, requestId: string, approve: boolean, ipAddress: string | undefined) {
  assertNotImpersonating(caller);
  const request = await requirePendingRequest(requestId);
  // Declining is always allowed, so nobody is left with a request they can't close.
  if (approve && !(await findPermissionsIn(caller, MASTER_MODULE_KEY))[CONNECT_APP_PERMISSION]) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to connect apps. Ask an admin for API access.');
  }

  const code = approve ? randomBytes(CODE_BYTES).toString('base64url') : null;
  if (!(await recordAuthorizationDecision(requestId, caller.user._id, code && hashRandomToken(code)))) {
    throw new ApiError(409, 'request_answered', 'This sign-in request has already been answered.');
  }
  await recordAudit({
    action: approve ? 'oauth.app_approved' : 'oauth.app_declined',
    actorId: caller.user._id,
    actorName: caller.user.name,
    targetType: 'oauthClient',
    targetId: request.clientId,
    targetName: clientNameOf(await findOAuthClient(request.clientId)),
    ip: ipAddress,
  });

  const redirect = new URL(request.redirectUri);
  if (code) {
    redirect.searchParams.set('code', code);
  } else {
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'The user declined access');
  }
  if (request.state) redirect.searchParams.set('state', request.state);
  return { redirectUrl: redirect.href };
}

export async function listConnectedApps(userId: string) {
  const grants = await findLiveGrantsOf(userId);
  const clients = new Map((await findOAuthClientsByIds([...new Set(grants.map((grant) => grant.clientId))])).map((client) => [client._id, client]));
  return grants.map((grant) => ({
    id: grant._id,
    clientName: clientNameOf(clients.get(grant.clientId)),
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
  }));
}

/** Disconnects one of the person's apps. Someone else's answers as not found, so ids can't be probed. */
export async function revokeConnectedApp(caller: Caller, grantId: string, ipAddress: string | undefined) {
  const grant = await findGrantOf(caller.user._id, grantId);
  if (!grant) throw unknownConnection();
  return disconnect(caller.user, grant, ipAddress);
}

const unknownConnection = () => new ApiError(404, 'unknown_connection', 'No such connected app.');

async function disconnect(actorUser: Pick<UserDoc, '_id' | 'name'>, grant: OAuthGrantDoc, ipAddress: string | undefined) {
  if (!grant.revokedAt) {
    await markGrantRevoked(grant._id);
    await recordAudit({
      action: 'oauth.app_disconnected',
      actorId: actorUser._id,
      actorName: actorUser.name,
      targetType: 'oauthClient',
      targetId: grant.clientId,
      targetName: clientNameOf(await findOAuthClient(grant.clientId)),
      ip: ipAddress,
    });
  }
  return { id: grant._id, revoked: true };
}

/** One page of the connected apps of everyone apiToken.read reaches, newest first. userId narrows it to one person. */
export async function listConnectedAppsInScope(actor: Actor, scope: Scope, query: PageRequest & { userId?: string }) {
  const reach = await findTokenOwnerReach(actor, scope);
  if (query.userId && !reachesOwner(reach, query.userId)) return { total: 0, apps: [] };

  const { grants, total } = await findLiveGrantPage(query.userId ?? ownerReachCondition(reach), query);
  const [clients, owners] = await Promise.all([
    findOAuthClientsByIds([...new Set(grants.map((grant) => grant.clientId))]),
    findUsersByIds([...new Set(grants.map((grant) => grant.userId))]),
  ]);
  const clientsById = new Map(clients.map((client) => [client._id, client]));
  const ownerNames = new Map(owners.map((owner) => [owner._id, owner.name]));
  return {
    total,
    apps: grants.map((grant) => ({
      id: grant._id,
      clientName: clientNameOf(clientsById.get(grant.clientId)),
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      owner: { id: grant.userId, name: ownerNames.get(grant.userId) ?? 'Removed person' },
    })),
  };
}

/** Disconnects anyone's app that apiToken.delete reaches. Apps out of reach answer as not found. */
export async function revokeConnectedAppInScope(actor: Actor, scope: Scope, grantId: string) {
  const grant = await findGrantById(grantId);
  if (!grant || !reachesOwner(await findTokenOwnerReach(actor, scope), grant.userId)) throw unknownConnection();
  return disconnect(actor.user, grant, actor.ipAddress);
}

export const isOAuthAccessToken = (presented: string) => presented.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);

/** The active person an OAuth access token acts for. Null when the token doesn't work. */
export async function resolveOAuthAccessToken(presented: string): Promise<UserDoc | null> {
  const grant = await findUsableGrant(presented);
  if (!grant) return null;
  await recordGrantUsed(grant._id, new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS));
  return findUserById(grant.userId);
}
