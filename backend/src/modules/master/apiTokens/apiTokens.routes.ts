import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import { createApiToken, listApiTokens, revokeApiToken } from './apiTokens.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_EXPIRY_DAYS = 365;

const createBodySchema = z.strictObject({
  name: z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH),
  // Missing means the token never expires. Revoking it still ends it.
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
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

/** Everyone manages only their own tokens, so these are signed routes. */
export const apiTokensRoutes: ApiRoute[] = [
  { method: 'GET', path: '/me/api-tokens', access: 'signed', handler: handleList },
  { method: 'POST', path: '/me/api-tokens', access: 'signed', handler: handleCreate },
  { method: 'POST', path: '/me/api-tokens/:id/revoke', access: 'signed', handler: handleRevoke },
];
