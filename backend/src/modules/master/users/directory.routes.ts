import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import { listDirectory } from './directory.service.js';
import { recordHeartbeat } from './presence.service.js';

const MAX_SEARCH_LENGTH = 100;

const directoryQuerySchema = z.object({
  ...paginationQueryFields,
  search: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
});

const handleListDirectory: RequestHandler = async (req, res) => {
  res.json(await listDirectory(getCaller(req), parseRequestQuery(directoryQuerySchema, req.query)));
};

const handleHeartbeat: RequestHandler = async (req, res) => {
  await recordHeartbeat(getCaller(req).user._id);
  res.status(204).end();
};

export const directoryRoutes: ApiRoute[] = [
  // Everyone signed in can look up colleagues. presence.read decides whose online status they also see.
  { method: 'GET', path: '/directory', access: 'signed', handler: handleListDirectory },
  // Open apps call this about every 45 seconds, so the person shows as online.
  { method: 'POST', path: '/me/heartbeat', access: 'signed', handler: handleHeartbeat },
];
