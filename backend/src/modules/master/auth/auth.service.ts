import { randomUUID } from 'node:crypto';
import type { AuthSettings } from '../../../config.js';
import { ApiError } from '../../../lib/errors.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { SessionDoc } from '../models/session.js';
import { findUserById, findUserWithPasswordByEmail, recordUserSignedIn } from '../users/users.repository.js';
import { isPasswordCorrect } from './passwords.js';
import {
  createSession,
  findSessionByTokenHash,
  revokeSession,
  rotateSessionToken,
} from './session.repository.js';
import { createAccessToken, createRefreshToken, hashRandomToken } from './tokens.js';

const MILLISECONDS_PER_DAY = 86_400_000;

/** The session can no longer be used, so the caller should also remove the refresh cookie. */
export class SessionEndedError extends ApiError {
  constructor(code: string, message: string) {
    super(401, code, message);
  }
}

export interface RefreshCookieValue {
  token: string;
  expiresAt: Date;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  refreshCookie: RefreshCookieValue;
}

export interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  /** Missing during the grace period, because the browser already holds the newest cookie. */
  refreshCookie?: RefreshCookieValue;
}

const daysFromNow = (days: number) => new Date(Date.now() + days * MILLISECONDS_PER_DAY);

export async function login(
  credentials: { email: string; password: string },
  ipAddress: string | undefined,
  settings: AuthSettings,
): Promise<LoginResult> {
  const user = await findUserWithPasswordByEmail(credentials.email);
  const isCorrect = await isPasswordCorrect(credentials.password, user?.passwordHash);

  if (!user || !isCorrect) {
    if (user) await recordAudit({ action: 'auth.login_failed', actorId: user._id, actorName: user.name, ip: ipAddress });
    throw new ApiError(401, 'invalid_credentials', 'That email and password do not match.');
  }
  // Checked after the password, so only the account's owner can learn that it's deactivated.
  if (user.status !== 'active') {
    throw new ApiError(403, 'account_inactive', 'This account has been deactivated. Contact HR.');
  }

  const sessionId = randomUUID();
  const refreshToken = createRefreshToken();
  const expiresAt = daysFromNow(settings.sessionIdleDays);
  await createSession({
    sessionId,
    userId: user._id,
    tokenHash: hashRandomToken(refreshToken),
    expiresAt,
    absoluteExpiresAt: daysFromNow(settings.sessionMaxDays),
  });
  await recordUserSignedIn(user._id);
  await recordAudit({ action: 'auth.login', actorId: user._id, actorName: user.name, ip: ipAddress });

  return {
    accessToken: await createAccessToken({ userId: user._id, sessionId }, settings),
    expiresIn: settings.accessTokenTtlSeconds,
    refreshCookie: { token: refreshToken, expiresAt },
  };
}

export function hasSessionExpired(session: SessionDoc): boolean {
  const now = Date.now();
  return session.expiresAt.getTime() <= now || session.absoluteExpiresAt.getTime() <= now;
}

function isWithinGracePeriod(session: SessionDoc, tokenHash: string, settings: AuthSettings): boolean {
  if (session.previousHash !== tokenHash || !session.rotatedAt) return false;
  return Date.now() - session.rotatedAt.getTime() <= settings.refreshGraceSeconds * 1000;
}

/** Ends the session if it can't be refreshed, and returns the session's active user otherwise. */
async function requireUsableSession(session: SessionDoc) {
  if (session.revokedAt) throw new SessionEndedError('session_revoked', 'Your session has ended. Sign in again.');

  if (hasSessionExpired(session)) {
    await revokeSession(session._id);
    throw new SessionEndedError('session_expired', 'Your session has expired. Sign in again.');
  }

  const user = await findUserById(session.userId);
  if (user?.status !== 'active') {
    await revokeSession(session._id);
    throw new SessionEndedError('account_inactive', 'This account has been deactivated. Contact HR.');
  }
  return user;
}

/** An old token used after the grace period means it may have been stolen, so the whole session ends. */
async function endSessionForTokenReuse(session: SessionDoc, actorName: string, ipAddress: string | undefined): Promise<never> {
  const wasActive = await revokeSession(session._id);
  if (wasActive) {
    await recordAudit({ action: 'auth.session_token_reused', actorId: session.userId, actorName, ip: ipAddress });
  }
  throw new SessionEndedError('session_revoked', 'Your session has ended. Sign in again.');
}

/**
 * Exchanges a refresh token for a new access token and replaces the refresh token. When two tabs refresh together,
 * one replaces the token and the other falls into the grace period, so neither triggers reuse detection.
 */
export async function refresh(
  presentedToken: string | undefined,
  ipAddress: string | undefined,
  settings: AuthSettings,
): Promise<RefreshResult> {
  if (!presentedToken) throw new SessionEndedError('no_session', 'Sign in to continue.');

  const presentedHash = hashRandomToken(presentedToken);
  const session = await findSessionByTokenHash(presentedHash);
  if (!session) throw new SessionEndedError('session_revoked', 'Your session has ended. Sign in again.');

  const user = await requireUsableSession(session);
  const accessToken = await createAccessToken({ userId: user._id, sessionId: session._id }, settings);
  const expiresIn = settings.accessTokenTtlSeconds;

  if (session.tokenHash === presentedHash) {
    const newToken = createRefreshToken();
    const expiresAt = new Date(
      Math.min(daysFromNow(settings.sessionIdleDays).getTime(), session.absoluteExpiresAt.getTime()),
    );
    const wasRotated = await rotateSessionToken({
      sessionId: session._id,
      presentedHash,
      newHash: hashRandomToken(newToken),
      expiresAt,
    });
    if (wasRotated) return { accessToken, expiresIn, refreshCookie: { token: newToken, expiresAt } };

    // Another request replaced this token between the read and the update, which is the grace case.
    return { accessToken, expiresIn };
  }

  if (isWithinGracePeriod(session, presentedHash, settings)) return { accessToken, expiresIn };

  return endSessionForTokenReuse(session, user.name, ipAddress);
}

/** Ends the session the refresh token belongs to. Succeeds with no token too, so signing out always works. */
export async function logout(presentedToken: string | undefined, ipAddress: string | undefined): Promise<void> {
  if (!presentedToken) return;

  const session = await findSessionByTokenHash(hashRandomToken(presentedToken));
  if (!session) return;

  const wasActive = await revokeSession(session._id);
  if (wasActive) await recordAudit({ action: 'auth.logout', actorId: session.userId, ip: ipAddress });
}
