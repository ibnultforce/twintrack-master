import { randomUUID } from 'node:crypto';
import type { AuthSettings } from '../../../config.js';
import { ApiError } from '../../../lib/errors.js';
import type { Caller } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { findUserById } from '../users/users.repository.js';
import { hasSessionExpired, SessionEndedError } from './auth.service.js';
import { createSession, findSessionById, revokeSession } from './session.repository.js';
import { createAccessToken, createRefreshToken, hashRandomToken } from './tokens.js';

export interface ImpersonationResult {
  accessToken: string;
  expiresIn: number;
  user: { id: string; name: string };
}

const refusal = (status: number, code: string, message: string) => new ApiError(status, code, message);

/**
 * Lets a super admin see the app as someone else, to check what that person's access shows them. Development only.
 * The session lasts one access token and has no refresh cookie, so the super admin's own session is untouched and
 * stopping hands it back.
 */
export async function startImpersonation(caller: Caller, targetId: string, settings: AuthSettings, ipAddress: string | undefined): Promise<ImpersonationResult> {
  if (!settings.isImpersonationEnabled) {
    throw refusal(404, 'impersonation_disabled', 'Signing in as someone else is only available in development.');
  }
  if (!caller.user.superAdmin) throw refusal(403, 'forbidden', 'Only a super admin can sign in as someone else.');
  if (caller.impersonatorId) throw refusal(409, 'already_impersonating', 'Stop signing in as this person first.');

  const target = await findUserById(targetId);
  if (!target) throw refusal(404, 'unknown_user', 'No such user.');
  if (target._id === caller.user._id) throw refusal(409, 'own_account', 'You are already signed in as yourself.');
  if (target.superAdmin) throw refusal(403, 'super_admin_protected', 'Nobody can sign in as a super admin.');
  if (target.status !== 'active') throw refusal(409, 'account_inactive', 'This account has been deactivated.');

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + settings.accessTokenTtlSeconds * 1000);
  await createSession({
    sessionId,
    userId: target._id,
    // Never handed out: this session can't be refreshed.
    tokenHash: hashRandomToken(createRefreshToken()),
    expiresAt,
    absoluteExpiresAt: expiresAt,
    impersonatorId: caller.user._id,
    impersonatorSessionId: caller.sessionId,
  });
  await recordAudit({
    action: 'auth.impersonation_started',
    actorId: caller.user._id,
    actorName: caller.user.name,
    targetType: 'user',
    targetId: target._id,
    targetName: target.name,
    ip: ipAddress,
  });

  return {
    accessToken: await createAccessToken({ userId: target._id, sessionId }, settings),
    expiresIn: settings.accessTokenTtlSeconds,
    user: { id: target._id, name: target.name },
  };
}

/** Ends an impersonation and returns a new access token for the super admin's own session. */
export async function stopImpersonation(caller: Caller, settings: AuthSettings, ipAddress: string | undefined) {
  if (!caller.impersonatorId) throw refusal(409, 'not_impersonating', 'You are not signed in as someone else.');
  const session = await findSessionById(caller.sessionId);
  await revokeSession(caller.sessionId);

  const [admin, adminSession] = await Promise.all([
    findUserById(caller.impersonatorId),
    session?.impersonatorSessionId ? findSessionById(session.impersonatorSessionId) : null,
  ]);
  if (!admin?.superAdmin || admin.status !== 'active' || !adminSession || adminSession.revokedAt || hasSessionExpired(adminSession)) {
    throw new SessionEndedError('session_revoked', 'Your own session has ended. Sign in again.');
  }

  await recordAudit({
    action: 'auth.impersonation_stopped',
    actorId: admin._id,
    actorName: admin.name,
    targetType: 'user',
    targetId: caller.user._id,
    targetName: caller.user.name,
    ip: ipAddress,
  });
  return {
    accessToken: await createAccessToken({ userId: admin._id, sessionId: adminSession._id }, settings),
    expiresIn: settings.accessTokenTtlSeconds,
  };
}
