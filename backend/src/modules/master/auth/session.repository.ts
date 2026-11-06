import type { ClientSession } from 'mongoose';
import { Session } from '../models/session.js';

export interface NewSession {
  sessionId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export async function createSession({ sessionId, ...session }: NewSession): Promise<void> {
  await Session.create({ _id: sessionId, ...session });
}

export function findSessionById(sessionId: string) {
  return Session.findById(sessionId).lean();
}

/** Finds a session from its current refresh token or any earlier one. */
export function findSessionByTokenHash(tokenHash: string) {
  return Session.findOne({ $or: [{ tokenHash }, { usedHashes: tokenHash }] }).lean();
}

/**
 * Replaces the current refresh token. The update only applies if presentedHash is still current, so when two
 * requests race, exactly one succeeds. Returns false for the one that lost.
 */
export async function rotateSessionToken(rotation: {
  sessionId: string;
  presentedHash: string;
  newHash: string;
  expiresAt: Date;
}): Promise<boolean> {
  const { sessionId, presentedHash, newHash, expiresAt } = rotation;
  const result = await Session.updateOne(
    { _id: sessionId, tokenHash: presentedHash, revokedAt: { $exists: false } },
    {
      $set: { tokenHash: newHash, previousHash: presentedHash, rotatedAt: new Date(), expiresAt },
      $addToSet: { usedHashes: presentedHash },
    },
  );
  return result.modifiedCount > 0;
}

export async function revokeOtherUserSessions(userId: string, keptSessionId: string, session?: ClientSession): Promise<void> {
  await Session.updateMany(
    { userId, _id: { $ne: keptSessionId }, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
    { session },
  );
}

export async function revokeAllUserSessions(userId: string, session?: ClientSession): Promise<void> {
  await Session.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session });
}

/** Ends a session. Returns false if it had already ended. */
export async function revokeSession(sessionId: string): Promise<boolean> {
  const result = await Session.updateOne(
    { _id: sessionId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}
