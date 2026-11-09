import type { RequestHandler } from 'express';
import { ApiError } from '../../../lib/errors.js';
import type { UserDoc } from '../models/user.js';
import { getCaller } from './caller.js';

/** For signed routes whose services work out the caller's rights. Runs before the body is read, so someone with no rights is refused the same way as on a private route. */
export const refuseUnless = (isAllowed: (user: UserDoc) => Promise<boolean>): RequestHandler => async (req, _res, next) => {
  if (!(await isAllowed(getCaller(req).user))) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  next();
};
