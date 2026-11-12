import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor, getCaller } from '../access/caller.js';
import { getPermissionScope } from '../access/scope.js';
import { createApiToken, listApiTokens, listApiTokensInScope, revokeApiToken, revokeApiTokenInScope } from './apiTokens.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_EXPIRY_DAYS = 365;

const createBodySchema = z.strictObject({
  name: z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH),
  // Missing means the token never expires. Revoking it still ends it.
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
});

const MAX_USER_ID_LENGTH = 100;

const listInScopeQuerySchema = z.object({
  ...paginationQueryFields,
  userId: z.string().trim().min(1).max(MAX_USER_ID_LENGTH).optional(),
});

const handleList: RequestHandler = async (req, res) => {
  res.json({ tokens: await listApiTokens(getCaller(req).user._id) });
};

const handleCreate: RequestHandler = async (req, res) => {
  const created = await createApiToken(getCaller(req), parseRequestBody(createBodySchema, req.body), req.ip);
  // The token is in this response only, so nothing may keep a copy.
  res.status(201).set('Cache-Control', 'no-store').json(created);
};

const handleRevoke: RequestHandler = async (req, res) => {
  res.json(await revokeApiToken(getCaller(req), String(req.params.id), req.ip));
};

const handleListInScope: RequestHandler = async (req, res) => {
  res.json(await listApiTokensInScope(getActor(req), getPermissionScope(req), parseRequestQuery(listInScopeQuerySchema, req.query)));
};

const handleRevokeInScope: RequestHandler = async (req, res) => {
  res.json(await revokeApiTokenInScope(getActor(req), getPermissionScope(req), String(req.params.id)));
};

/**
 * /me routes: a person's own tokens. Listing and revoking your own needs only a session, so nobody is ever stuck
 * with a token they can't stop; making one needs apiToken.create.
 * /api-tokens routes: an admin's view of everyone their apiToken scope reaches.
 */
export const apiTokensRoutes: ApiRoute[] = [
  { method: 'GET', path: '/me/api-tokens', access: 'signed', handler: handleList },
  { method: 'POST', path: '/me/api-tokens', access: 'private', permission: 'apiToken.create', handler: handleCreate },
  { method: 'POST', path: '/me/api-tokens/:id/revoke', access: 'signed', handler: handleRevoke },
  { method: 'GET', path: '/api-tokens', access: 'private', permission: 'apiToken.read', handler: handleListInScope },
  { method: 'POST', path: '/api-tokens/:id/revoke', access: 'private', permission: 'apiToken.delete', handler: handleRevokeInScope },
];
