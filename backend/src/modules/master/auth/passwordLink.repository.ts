import type { ClientSession } from 'mongoose';
import { PasswordLink, type PasswordLinkDoc } from '../models/passwordLink.js';

export type NewPasswordLink = Pick<PasswordLinkDoc, '_id' | 'userId' | 'tokenHash' | 'purpose' | 'createdBy' | 'expiresAt'>;

/** Saves a new link and removes the person's earlier ones, so only the newest link works. */
export async function replacePasswordLinks(link: NewPasswordLink, session: ClientSession): Promise<void> {
  await PasswordLink.deleteMany({ userId: link.userId }, { session });
  await PasswordLink.create([link], { session });
}

/**
 * Takes an unexpired link out of the database and returns it, or null when there's no such link. Removing it in the
 * same step means two requests racing with one link can't both use it.
 */
export function takeUsablePasswordLink(tokenHash: string, session: ClientSession) {
  return PasswordLink.findOneAndDelete({ tokenHash, expiresAt: { $gt: new Date() } }, { session }).lean();
}

export async function deletePasswordLinksOf(userId: string, session: ClientSession): Promise<void> {
  await PasswordLink.deleteMany({ userId }, { session });
}
