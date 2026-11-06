import type { Request } from 'express';
import type { UserDoc } from '../models/user.js';
import type { Scope } from '../moduleRegistry/manifest.js';

export interface Caller {
  user: UserDoc;
  sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the session check on signed and private routes. */
    caller?: Caller;
    /** Set by the permission check on private routes: how much of the data this caller may use. */
    permissionScope?: Scope;
  }
}

export function getCaller(req: Request): Caller {
  if (!req.caller) throw new Error(`${req.method} ${req.path} used the caller without a session check.`);
  return req.caller;
}
