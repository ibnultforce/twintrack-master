import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthSettings } from '../../../config.js';
import { ApiError } from '../../../lib/errors.js';
import { assertNotImpersonating, type Caller } from '../access/caller.js';
import { resolveModuleAccess } from '../access/permissions.js';
import { recordAudit } from '../audit/audit.repository.js';
import { HandoffCode } from '../models/handoffCode.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { findUserById } from '../users/users.repository.js';
import { hasSessionExpired } from './auth.service.js';
import { findSessionById } from './session.repository.js';
import { createAccessToken, hashRandomToken } from './tokens.js';

const CODE_BYTES = 32;
export const HANDOFF_CODE_TTL_SECONDS = 60;
const MILLISECONDS_PER_SECOND = 1000;

const invalidCode = () => new ApiError(400, 'invalid_code', 'This sign-in code is invalid, used or expired. Open the app from TwinTrack again.');

/**
 * Makes a one-time code that signs the caller in to a module's frontend, and the address to send them to with it.
 * The address must be one a super admin saved for the module, matched exactly, so a crafted link can't send the code
 * anywhere else.
 */
export async function createHandoff(caller: Caller, moduleKey: string, requestedRedirectUrl: string | undefined, ipAddress: string | undefined) {
  assertNotImpersonating(caller);
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  if (!resolveModuleAccess(caller, module).hasAccess) throw new ApiError(403, 'forbidden', `You don't have access to ${module.name}.`);

  const redirectUrls = module.frontendSettings?.redirectUrls ?? [];
  if (redirectUrls.length === 0) throw new ApiError(409, 'no_redirect_url', `${module.name} has no sign-in address yet. A super admin sets it on the Modules screen.`);
  const redirectUrl = requestedRedirectUrl ?? redirectUrls[0]!;
  if (!redirectUrls.includes(redirectUrl)) throw new ApiError(422, 'unknown_redirect_url', `That address isn't one of ${module.name}'s sign-in addresses.`);

  const code = randomBytes(CODE_BYTES).toString('base64url');
  await HandoffCode.create({
    _id: randomUUID(),
    codeHash: hashRandomToken(code),
    userId: caller.user._id,
    sessionId: caller.sessionId,
    moduleKey: module.key,
    redirectUrl,
    expiresAt: new Date(Date.now() + HANDOFF_CODE_TTL_SECONDS * MILLISECONDS_PER_SECOND),
  });
  await recordAudit({ action: 'auth.handoff_issued', actorId: caller.user._id, actorName: caller.user.name, module: module.key, ip: ipAddress, after: { redirectUrl } });

  const destination = new URL(redirectUrl);
  destination.searchParams.set('code', code);
  return { redirectTo: destination.toString(), expiresIn: HANDOFF_CODE_TTL_SECONDS };
}

/**
 * Exchanges a code for an access token on the Master session it was made from. The code is deleted first, so it
 * works once even when two requests race. The page exchanging it must be on the address the code was sent to.
 */
export async function exchangeHandoff(code: string, origin: string | undefined, ipAddress: string | undefined, settings: AuthSettings) {
  const handoff = await HandoffCode.findOneAndDelete({ codeHash: hashRandomToken(code) }).lean();
  if (!handoff || handoff.expiresAt.getTime() <= Date.now()) throw invalidCode();
  if (origin !== new URL(handoff.redirectUrl).origin) throw new ApiError(403, 'origin_not_allowed', 'This address may not use that sign-in code.');

  const [session, user] = await Promise.all([findSessionById(handoff.sessionId), findUserById(handoff.userId)]);
  if (!session || session.revokedAt || hasSessionExpired(session) || user?.status !== 'active') {
    throw new ApiError(401, 'session_revoked', 'Your TwinTrack session has ended. Sign in again.');
  }

  await recordAudit({ action: 'auth.handoff_used', actorId: user._id, actorName: user.name, module: handoff.moduleKey, ip: ipAddress });
  return {
    accessToken: await createAccessToken({ userId: user._id, sessionId: session._id }, settings),
    expiresIn: settings.accessTokenTtlSeconds,
    module: handoff.moduleKey,
  };
}
