import { createHash, randomBytes } from 'node:crypto';
import { errors, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { AuthSettings } from '../../../config.js';
import { ApiError } from '../../../lib/errors.js';

const REFRESH_TOKEN_BYTES = 32;
const ACCESS_TOKEN_ALGORITHM = 'HS256';

export interface AccessTokenIdentity {
  userId: string;
  sessionId: string;
}

const signingKey = (settings: AuthSettings) => new TextEncoder().encode(settings.accessTokenSecret);

/** Holds identity only. Permissions are read from the database on each call, so changes apply immediately. */
export function createAccessToken(identity: AccessTokenIdentity, settings: AuthSettings): Promise<string> {
  return new SignJWT({ sid: identity.sessionId })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(identity.userId)
    .setIssuer(settings.tokenIssuer)
    .setAudience(settings.tokenIssuer)
    .setIssuedAt()
    .setExpirationTime(`${settings.accessTokenTtlSeconds}s`)
    .sign(signingKey(settings));
}

async function readVerifiedClaims(accessToken: string, settings: AuthSettings): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(accessToken, signingKey(settings), {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: settings.tokenIssuer,
      audience: settings.tokenIssuer,
    });
    return payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new ApiError(401, 'token_expired', 'Access token expired.');
    if (error instanceof errors.JOSEError) throw new ApiError(401, 'invalid_token', 'Invalid access token.');
    throw error;
  }
}

/** Checks the signature, algorithm, issuer, audience and expiry, then returns who the token belongs to. */
export async function verifyAccessToken(accessToken: string, settings: AuthSettings): Promise<AccessTokenIdentity> {
  const { sub: userId, sid: sessionId } = await readVerifiedClaims(accessToken, settings);
  if (typeof userId !== 'string' || typeof sessionId !== 'string') {
    throw new ApiError(401, 'invalid_token', 'Invalid access token.');
  }
  return { userId, sessionId };
}

export function createRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a long random token, such as a refresh token or a password link, so only the hash need be stored. The token
 * is random, not chosen by a person, so a fast hash is safe.
 */
export function hashRandomToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
