import type { Request, RequestHandler } from 'express';
import type { AuthSettings } from '../../../config.js';
import type { AccessMiddlewareFor } from '../../../lib/apiRoute.js';
import { ApiError } from '../../../lib/errors.js';
import { findProfileOf } from '../accessProfiles/accessProfiles.repository.js';
import { hasSessionExpired } from '../auth/auth.service.js';
import { findSessionById } from '../auth/session.repository.js';
import { verifyAccessToken } from '../auth/tokens.js';
import type { ModuleDoc } from '../models/module.js';
import type { Scope } from '../moduleRegistry/manifest.js';
import { findModuleByKey } from '../moduleRegistry/moduleRegistry.repository.js';
import { declaredPermissions, resolveRouteRule } from '../moduleRegistry/routeAccess.js';
import { findUserById } from '../users/users.repository.js';
import { getCaller } from './caller.js';
import { resolveModuleAccess } from './permissions.js';

const BEARER_PREFIX = 'Bearer ';
// Least privilege for someone reaching an opened API without its permission.
const OPENED_API_SCOPE: Scope = 'own';

/** Checks the access token and its session, then loads the person and their profile as the caller. */
function createCallerLoader(settings: AuthSettings) {
  return async (req: Request): Promise<void> => {
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
  };
}

/** Profiles are read from the database on each call, so a change applies on the next request. */
function applyPermission(req: Request, module: ModuleDoc, acceptedPermissions: string[]): void {
  const access = resolveModuleAccess(getCaller(req), module);
  const heldPermission = acceptedPermissions.find((permission) => access.permissions[permission]);
  if (!heldPermission) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');

  req.permissionScope = access.permissions[heldPermission];
  req.callerPermissions = access.permissions;
  req.callerFieldAccess = access.fieldAccess;
}

/**
 * For an API built private that a super admin opened to every signed-in person. Its code still reads a scope, so a
 * person holding one of its permissions keeps that scope, and anyone else reaches only their own records.
 */
function applyOpenedPermission(req: Request, module: ModuleDoc, builtPermissions: string[]): void {
  const access = resolveModuleAccess(getCaller(req), module);
  const heldPermission = builtPermissions.find((permission) => access.permissions[permission]);

  req.permissionScope = heldPermission ? access.permissions[heldPermission] : OPENED_API_SCOPE;
  req.callerPermissions = access.permissions;
  req.callerFieldAccess = access.fieldAccess;
}

/**
 * Enforces each route's access rule, read from the module on every request, so a super admin's change applies on the
 * next call. A route built public needs no session and can't be changed, so it reads nothing.
 */
export function createAccessMiddleware(settings: AuthSettings, moduleKey: string): AccessMiddlewareFor {
  const loadCaller = createCallerLoader(settings);

  return (route) => {
    if (route.access === 'public') return [];

    const checkAccess: RequestHandler = async (req, _res, next) => {
      const module = await findModuleByKey(moduleKey);
      const rule = resolveRouteRule(route, route.path, module?.routeAccess);
      await loadCaller(req);

      if (rule.access === 'private') {
        // A module that isn't loaded grants nothing.
        if (!module) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
        applyPermission(req, module, rule.permissions);
      } else if (route.access === 'private' && module) {
        applyOpenedPermission(req, module, declaredPermissions(route));
      }
      next();
    };
    return [checkAccess];
  };
}
