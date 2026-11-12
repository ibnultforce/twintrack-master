import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { getPersonPoints, listPointsTotals } from './points.service.js';

const pointsQuerySchema = z.object({
  ...paginationQueryFields,
  // From this date only, such as the start of a review cycle. Missing means all time.
  since: z.iso.date('must be a date, such as 2026-07-01').transform((value) => new Date(value)).optional(),
});

const handleList: RequestHandler = async (req, res) => {
  res.json(await listPointsTotals(getActor(req), scopeOf(req), parseRequestQuery(pointsQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getPersonPoints(getActor(req), scopeOf(req), String(req.params.userId), parseRequestQuery(pointsQuerySchema, req.query)));
};

/** Points are earned when tasks are approved and lost on reverts, so these routes only read them. */
export const pointsRoutes: ApiRoute[] = [
  { method: 'GET', path: '/tasks/points', access: 'private', permission: 'points.read', handler: handleList },
  { method: 'GET', path: '/tasks/points/:userId', access: 'private', permission: 'points.read', handler: handleGet },
];
