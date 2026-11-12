import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { assertNotImpersonating, type Actor, type Caller } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { hashRandomToken } from '../auth/tokens.js';
import type { ApiTokenDoc } from '../models/apiToken.js';
import type { UserDoc } from '../models/user.js';
import type { Scope } from '../moduleRegistry/manifest.js';
import { findUserById, findUsersByIds } from '../users/users.repository.js';
import {
  countActiveApiTokensOf,
  findApiTokenById,
  findApiTokenByHash,
  findApiTokenOf,
  findApiTokenPage,
  findApiTokensOf,
  insertApiToken,
  markApiTokenRevoked,
  recordApiTokenUsed,
} from './apiTokens.repository.js';
import { findTokenOwnerReach, ownerReachCondition, reachesOwner } from './tokenOwnerReach.js';

export const API_TOKEN_PREFIX = 'tt_pat_';
const TOKEN_BYTES = 32;
const VISIBLE_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 4;
/** Plenty for one person's tools and computers, and stops a runaway script piling tokens up. */
const MAX_ACTIVE_TOKENS = 10;
const MILLISECONDS_PER_DAY = 86_400_000;
/** Recording every use would write on every call, so a use is recorded at most this often. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

const toApiTokenView = (token: ApiTokenDoc): ApiTokenView => ({
  id: token._id,
  name: token.name,
  prefix: token.prefix,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  createdAt: token.createdAt,
});

const unknownToken = () => new ApiError(404, 'unknown_token', 'No such token.');

const auditFields = (caller: { user: Pick<UserDoc, '_id' | 'name'> }, token: Pick<ApiTokenDoc, '_id' | 'name'>, ipAddress: string | undefined) => ({
  actorId: caller.user._id,
  actorName: caller.user.name,
  targetType: 'apiToken',
  targetId: token._id,
  targetName: token.name,
  ip: ipAddress,
});

export async function listApiTokens(userId: string): Promise<ApiTokenView[]> {
  return (await findApiTokensOf(userId)).map(toApiTokenView);
}

/** Returns the token itself this once. Only its hash is kept, so it can never be shown again. */
export async function createApiToken(
  caller: Caller,
  request: { name: string; expiresInDays?: number },
  ipAddress: string | undefined,
): Promise<ApiTokenView & { token: string }> {
  // Someone seeing the app as this person must not walk away with a credential for them.
  assertNotImpersonating(caller);
  if ((await countActiveApiTokensOf(caller.user._id)) >= MAX_ACTIVE_TOKENS) {
    throw new ApiError(409, 'too_many_tokens', `You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
  }

  const token = API_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  const created = await insertApiToken({
    _id: `at_${randomUUID()}`,
    userId: caller.user._id,
    name: request.name,
    tokenHash: hashRandomToken(token),
    prefix: token.slice(0, VISIBLE_PREFIX_LENGTH),
    ...(request.expiresInDays && { expiresAt: new Date(Date.now() + request.expiresInDays * MILLISECONDS_PER_DAY) }),
  });
  await recordAudit({ action: 'apiToken.created', ...auditFields(caller, created, ipAddress) });
  return { ...toApiTokenView(created), token };
}

/** Someone else's token answers as not found, so ids can't be probed. */
export async function revokeApiToken(caller: Caller, tokenId: string, ipAddress: string | undefined): Promise<ApiTokenView> {
  const token = await findApiTokenOf(caller.user._id, tokenId);
  if (!token) throw unknownToken();
  if (token.revokedAt) return toApiTokenView(token);

  return markRevoked(caller, token, ipAddress);
}

async function markRevoked(revokedBy: { user: Pick<UserDoc, '_id' | 'name'> }, token: ApiTokenDoc, ipAddress: string | undefined) {
  const revoked = await markApiTokenRevoked(token._id);
  if (!revoked) throw unknownToken();
  await recordAudit({ action: 'apiToken.revoked', ...auditFields(revokedBy, token, ipAddress) });
  return toApiTokenView(revoked);
}

export type ApiTokenAdminView = ApiTokenView & { owner: { id: string; name: string } };

/** One page of the tokens of everyone apiToken.read reaches, newest first. userId narrows it to one person. */
export async function listApiTokensInScope(actor: Actor, scope: Scope, query: PageRequest & { userId?: string }) {
  const reach = await findTokenOwnerReach(actor, scope);
  if (query.userId && !reachesOwner(reach, query.userId)) return { total: 0, tokens: [] };

  const { tokens, total } = await findApiTokenPage(query.userId ?? ownerReachCondition(reach), query);
  const owners = new Map((await findUsersByIds([...new Set(tokens.map((token) => token.userId))])).map((user) => [user._id, user.name]));
  const views: ApiTokenAdminView[] = tokens.map((token) => ({
    ...toApiTokenView(token),
    owner: { id: token.userId, name: owners.get(token.userId) ?? 'Removed person' },
  }));
  return { total, tokens: views };
}

/** Revokes anyone's token that apiToken.delete reaches. Tokens out of reach answer as not found. */
export async function revokeApiTokenInScope(actor: Actor, scope: Scope, tokenId: string): Promise<ApiTokenView> {
  const token = await findApiTokenById(tokenId);
  if (!token || !reachesOwner(await findTokenOwnerReach(actor, scope), token.userId)) throw unknownToken();
  if (token.revokedAt) return toApiTokenView(token);
  return markRevoked(actor, token, actor.ipAddress);
}

export const isApiToken = (presented: string) => presented.startsWith(API_TOKEN_PREFIX);

/** The active person a token belongs to, read fresh so a deactivation applies at once. Null when it doesn't work. */
export async function resolveApiToken(presented: string): Promise<UserDoc | null> {
  const token = await findApiTokenByHash(hashRandomToken(presented));
  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) return null;

  const user = await findUserById(token.userId);
  if (user?.status !== 'active') return null;

  await recordApiTokenUsed(token._id, new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS));
  return user;
}
