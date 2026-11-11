import {
  OAuthAuthorizationRequest,
  OAuthClient,
  OAuthGrant,
  type OAuthAuthorizationRequestDoc,
  type OAuthClientDoc,
  type OAuthGrantDoc,
} from '../models/oauth.js';

export const findOAuthClient = (clientId: string) => OAuthClient.findById(clientId).lean();

export async function insertOAuthClient(client: Pick<OAuthClientDoc, '_id' | 'metadata' | 'clientSecretEncrypted'>): Promise<void> {
  await OAuthClient.create([client]);
}

export const findOAuthClientsByIds = (clientIds: string[]) => OAuthClient.find({ _id: { $in: clientIds } }).lean();

export type NewAuthorizationRequest = Pick<
  OAuthAuthorizationRequestDoc,
  '_id' | 'clientId' | 'redirectUri' | 'codeChallenge' | 'state' | 'scopes' | 'resource' | 'expiresAt'
>;

export async function insertAuthorizationRequest(request: NewAuthorizationRequest): Promise<void> {
  await OAuthAuthorizationRequest.create([request]);
}

export const findAuthorizationRequest = (requestId: string) => OAuthAuthorizationRequest.findById(requestId).lean();

export const findAuthorizationRequestByCode = (codeHash: string) => OAuthAuthorizationRequest.findOne({ codeHash }).lean();

/** Records the answer, unless someone answered first. Returns false for the one that lost. */
export async function recordAuthorizationDecision(requestId: string, userId: string, codeHash: string | null): Promise<boolean> {
  const result = await OAuthAuthorizationRequest.updateOne(
    { _id: requestId, decidedAt: { $exists: false } },
    { $set: { decidedAt: new Date(), userId, ...(codeHash && { codeHash }) } },
  );
  return result.modifiedCount > 0;
}

/** Marks a code as used. Returns false when it already was, which means it may have leaked. */
export async function consumeAuthorizationCode(requestId: string): Promise<boolean> {
  const result = await OAuthAuthorizationRequest.updateOne({ _id: requestId, consumedAt: { $exists: false } }, { $set: { consumedAt: new Date() } });
  return result.modifiedCount > 0;
}

export type NewGrant = Omit<OAuthGrantDoc, 'createdAt' | 'lastUsedAt' | 'revokedAt'>;

export async function insertGrant(grant: NewGrant): Promise<void> {
  await OAuthGrant.create([grant]);
}

export const findGrantByAccessToken = (accessTokenHash: string) => OAuthGrant.findOne({ accessTokenHash }).lean();

export const findGrantByRefreshToken = (refreshTokenHash: string) => OAuthGrant.findOne({ refreshTokenHash }).lean();

/** Swaps in new tokens, unless another request already rotated these. Returns false for the one that lost. */
export async function rotateGrantTokens(
  grantId: string,
  presentedRefreshHash: string,
  tokens: Pick<OAuthGrantDoc, 'accessTokenHash' | 'accessTokenExpiresAt' | 'refreshTokenHash' | 'refreshTokenExpiresAt'>,
): Promise<boolean> {
  const result = await OAuthGrant.updateOne({ _id: grantId, refreshTokenHash: presentedRefreshHash, revokedAt: { $exists: false } }, { $set: tokens });
  return result.modifiedCount > 0;
}

export async function revokeGrantsFromRequest(authorizationRequestId: string): Promise<void> {
  await OAuthGrant.updateMany({ authorizationRequestId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
}

/** Revokes the client's grant holding this token, whichever of its two tokens it is. */
export async function revokeGrantByToken(clientId: string, tokenHash: string): Promise<void> {
  await OAuthGrant.updateMany(
    { clientId, revokedAt: { $exists: false }, $or: [{ accessTokenHash: tokenHash }, { refreshTokenHash: tokenHash }] },
    { $set: { revokedAt: new Date() } },
  );
}

export async function recordGrantUsed(grantId: string, staleBefore: Date): Promise<void> {
  await OAuthGrant.updateOne(
    { _id: grantId, $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lt: staleBefore } }] },
    { $set: { lastUsedAt: new Date() } },
  );
}

/** A person's connections that still work: not revoked, and still able to refresh. */
export const findLiveGrantsOf = (userId: string) =>
  OAuthGrant.find({ userId, revokedAt: { $exists: false }, refreshTokenExpiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();

export const findGrantOf = (userId: string, grantId: string) => OAuthGrant.findOne({ _id: grantId, userId }).lean();

export async function markGrantRevoked(grantId: string): Promise<void> {
  await OAuthGrant.updateOne({ _id: grantId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
}
