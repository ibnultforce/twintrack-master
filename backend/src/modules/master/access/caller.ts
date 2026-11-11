import type { Request } from 'express';
import { ApiError } from '../../../lib/errors.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { UserDoc } from '../models/user.js';
import type { Scope } from '../moduleRegistry/manifest.js';
import type { FieldAccessMap, PermissionMap } from './permissions.js';

export interface Caller {
  user: UserDoc;
  /** The profile the person holds, read with them on each request. */
  profile: AccessProfileDoc | null;
  sessionId: string;
  /** Set when a super admin is seeing the app as this person, in development. */
  impersonatorId?: string;
}

/** Keeps a super admin seeing the app as someone from changing that person's account or credentials. */
export function assertNotImpersonating(caller: Caller): void {
  if (caller.impersonatorId) {
    throw new ApiError(403, 'impersonating', "You can't do this while signed in as someone else. Stop first.");
  }
}

/** Who is making an admin change: what services need for their own rules and for the activity log. */
export interface Actor {
  user: UserDoc;
  profile: AccessProfileDoc | null;
  ipAddress: string | undefined;
  /** Everything this person can do in the route's module, as read from the database for this request. */
  permissions: PermissionMap;
  /** Their access to protected fields in the route's module. */
  fieldAccess: FieldAccessMap;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the session check on signed and private routes. */
    caller?: Caller;
    /** Set by the permission check on private routes: how much of the data this caller may use. */
    permissionScope?: Scope;
    /** Set by the permission check on private routes. */
    callerPermissions?: PermissionMap;
    /** Set by the permission check on private routes. */
    callerFieldAccess?: FieldAccessMap;
  }
}

export function getCaller(req: Request): Caller {
  if (!req.caller) throw new Error(`${req.method} ${req.path} used the caller without a session check.`);
  return req.caller;
}

export function getActor(req: Request): Actor {
  if (!req.callerPermissions) throw new Error(`${req.method} ${req.path} used the actor without a permission check.`);
  const { user, profile } = getCaller(req);
  return { user, profile, ipAddress: req.ip, permissions: req.callerPermissions, fieldAccess: req.callerFieldAccess ?? {} };
}

/** For signed routes whose services work out the caller's rights themselves, because they span several modules. */
export function getSignedActor(req: Request): Actor {
  const { user, profile } = getCaller(req);
  return { user, profile, ipAddress: req.ip, permissions: {}, fieldAccess: {} };
}

export const actorFields =({ user, ipAddress }: Actor) => ({ actorId: user._id, actorName: user.name, ip: ipAddress });
