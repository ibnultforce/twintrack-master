import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { getCaller } from '../../master/access/caller.js';
import { directoryQuerySchema } from '../../master/users/directory.routes.js';
import { listDirectory } from '../../master/users/directory.service.js';

/**
 * Lists active colleagues from Master's directory, so a caller holding test.read can check a module reads people.
 * It returns only what GET /directory shows anyone signed in.
 */
const listUsers: RequestHandler = async (req, res) => {
  res.json(await listDirectory(getCaller(req), parseRequestQuery(directoryQuerySchema, req.query)));
};

export const usersRoutes: ApiRoute[] = [{ method: 'GET', path: '/test/users', access: 'private', permission: 'test.read', handler: listUsers }];
