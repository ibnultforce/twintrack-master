import type { RequestHandler } from 'express';
import type { AuthSettings } from '../../../config.js';
import type { AccessMiddlewareFor, ApiRoute } from '../../../lib/apiRoute.js';
import { ApiError } from '../../../lib/errors.js';
import { findProfileOf } from '../accessProfiles/accessProfiles.repository.js';
import { hasSessionExpired } from '../auth/auth.service.js';
import { findSessionById } from '../auth/session.repository.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { findUserById } from '../users/users.repository.js';
import { getCaller } from './caller.js';
import { resolveModuleAccess } from './permissions.js';

const BEARER_PREFIX = 'Bearer ';

function createSessionCheck(settings: AuthSettings): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('Authorization');
    if (!header?.startsWith(BEARER_PREFIX)) throw new ApiError(401, 'no_token', 'Sign in to continue.');

    const { userId, sessionId } = await verifyAccessToken(header.slice(BEARER_PREFIX.length), settings);
    const [session, user] = await Promise.all([findSessionById(sessionId), findUserById(userId)]);

    // An impersonation session stops working as soon as impersonation is switched off.
    const isRefusedImpersonation = Boolean(session?.impersonatorId) && !settings.isImpersonationEnabled;
    if (!session || session.userId !== userId || session.revokedAt || hasSessionExpired(session) || isRefusedImpersonation) {
      throw new ApiError(401, 'session_revoked', 'Your session has ended. Sign in again.');
    }
    if (user?.status !== 'active') {
      throw new ApiError(401, 'account_inactive', 'This account has been deactivated. Contact HR.');
    }

    req.caller = { user, profile: await findProfileOf(user), sessionId, impersonatorId: session.impersonatorId };
    next();
  };
}

/** Profiles are read from the database on each call, so a change applies on the next request. */
function createPermissionCheck(route: ApiRoute, moduleKey: string): RequestHandler {
  const acceptedPermissions = route.permission ? [route.permission] : (route.anyPermission ?? []);

  return async (req, _res, next) => {
    const module = await findModuleByKey(moduleKey);
    const access = module ? resolveModuleAccess(getCaller(req), module) : null;
    const permissions = access?.permissions ?? {};
    const heldPermission = acceptedPermissions.find((permission) => permissions[permission]);

    if (!heldPermission) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');

    req.permissionScope = permissions[heldPermission];
    req.callerPermissions = permissions;
    req.callerFieldAccess = access?.fieldAccess ?? {};
    next();
  };
}

/** Enforces each route's declared access: the session, then the permission. */
export function createAccessMiddleware(settings: AuthSettings, moduleKey: string): AccessMiddlewareFor {
  const requireSession = createSessionCheck(settings);

  return (route) => {
    if (route.access === 'public') return [];

    return route.access === 'private' ? [requireSession, createPermissionCheck(route, moduleKey)] : [requireSession];
  };
}
