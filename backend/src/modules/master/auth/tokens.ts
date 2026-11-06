import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AuthSettings } from '../../../config.js';

const REFRESH_TOKEN_BYTES = 32;

/** Holds identity only. Permissions are read from the database on each call, so changes apply immediately. */
export function createAccessToken(identity: { userId: string; sessionId: string }, settings: AuthSettings): Promise<string> {
  return new SignJWT({ sid: identity.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identity.userId)
    .setIssuer(settings.tokenIssuer)
    .setAudience(settings.tokenIssuer)
    .setIssuedAt()
    .setExpirationTime(`${settings.accessTokenTtlSeconds}s`)
    .sign(new TextEncoder().encode(settings.accessTokenSecret));
}

export function createRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** Refresh tokens are long and random, so a fast hash is safe. Only this hash is stored. */
export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}
