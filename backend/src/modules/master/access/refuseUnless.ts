import type { RequestHandler } from 'express';
import { ApiError } from '../../../lib/errors.js';
import { getCaller, type Caller } from './caller.js';

/** For signed routes whose services work out the caller's rights. Runs before the body is read, so someone with no rights is refused the same way as on a private route. */
export const refuseUnless = (isAllowed: (caller: Caller) => Promise<boolean>): RequestHandler => async (req, _res, next) => {
  if (!(await isAllowed(getCaller(req)))) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  next();
};
