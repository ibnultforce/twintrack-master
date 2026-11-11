import { ApiToken, type ApiTokenDoc } from '../models/apiToken.js';

export type NewApiToken = Pick<ApiTokenDoc, '_id' | 'userId' | 'name' | 'tokenHash' | 'prefix' | 'expiresAt'>;

const activeFilter = (userId: string) => ({
  userId,
  revokedAt: { $exists: false },
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
});

export const findApiTokensOf = (userId: string) => ApiToken.find({ userId }).sort({ createdAt: -1 }).lean();

export const countActiveApiTokensOf = (userId: string) => ApiToken.countDocuments(activeFilter(userId));

export async function insertApiToken(token: NewApiToken): Promise<ApiTokenDoc> {
  const [created] = await ApiToken.create([token]);
  if (!created) throw new Error('Creating the token returned nothing.');
  return created.toObject();
}

export const findApiTokenOf = (userId: string, tokenId: string) => ApiToken.findOne({ _id: tokenId, userId }).lean();

export const markApiTokenRevoked = (tokenId: string) =>
  ApiToken.findByIdAndUpdate(tokenId, { $set: { revokedAt: new Date() } }, { returnDocument: 'after' }).lean();

export const findApiTokenByHash = (tokenHash: string) => ApiToken.findOne({ tokenHash }).lean();

/** Records a use, unless one was already recorded after staleBefore. */
export async function recordApiTokenUsed(tokenId: string, staleBefore: Date): Promise<void> {
  await ApiToken.updateOne(
    { _id: tokenId, $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lt: staleBefore } }] },
    { $set: { lastUsedAt: new Date() } },
  );
}
