import { pageOffset, type PageRequest } from '../../../lib/query.js';
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

/** One page of tokens, newest first, for one person (an id) or the people a condition matches. */
export async function findApiTokenPage(userIdCondition: string | object, page: PageRequest) {
  const filter = { userId: userIdCondition };
  const [tokens, total] = await Promise.all([
    ApiToken.find(filter).sort({ createdAt: -1, _id: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    ApiToken.countDocuments(filter),
  ]);
  return { tokens, total };
}

export const findApiTokenById = (tokenId: string) => ApiToken.findById(tokenId).lean();

export const findApiTokenOf =(userId: string, tokenId: string) => ApiToken.findOne({ _id: tokenId, userId }).lean();

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
