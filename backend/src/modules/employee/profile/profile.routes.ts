import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../../master/access/caller.js';
import { getProfile, updateOwnName } from '../../master/auth/account.service.js';
import { nameField } from '../../master/users/userFields.js';

// Strict, so a request can't slip in other fields such as a title.
const updateBodySchema = z.strictObject({ name: nameField });

const handleRead: RequestHandler = async (req, res) => {
  res.json(await getProfile(getCaller(req).user));
};

const handleUpdate: RequestHandler = async (req, res) => {
  const { name } = parseRequestBody(updateBodySchema, req.body);
  res.json(await updateOwnName(getCaller(req), name, req.ip));
};

export const profileRoutes: ApiRoute[] = [
  { method: 'GET', path: '/employee/me/profile', access: 'private', permission: 'profile.read', handler: handleRead },
  { method: 'PATCH', path: '/employee/me/profile', access: 'private', permission: 'profile.update', handler: handleUpdate },
];
