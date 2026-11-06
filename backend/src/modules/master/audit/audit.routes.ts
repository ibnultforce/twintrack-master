import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { listActivity } from './audit.service.js';

const MAX_ACTION_PREFIX_LENGTH = 50;

const listActivityQuerySchema = z.object({
  ...paginationQueryFields,
  actionPrefix: z
    .string()
    .max(MAX_ACTION_PREFIX_LENGTH)
    .regex(/^[a-z_.]+$/, 'must be the start of an action, such as "auth."')
    .optional(),
});

const handleListActivity: RequestHandler = async (req, res) => {
  res.json(await listActivity(parseRequestQuery(listActivityQuerySchema, req.query)));
};

export const auditRoutes: ApiRoute[] = [
  { method: 'GET', path: '/audit', access: 'private', permission: 'audit.read', handler: handleListActivity },
];
