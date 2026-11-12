import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor, getCaller } from '../access/caller.js';
import { getPermissionScope } from '../access/scope.js';
import {
  decideAuthorizationRequest,
  getAuthorizationRequest,
  listConnectedApps,
  listConnectedAppsInScope,
  revokeConnectedApp,
  revokeConnectedAppInScope,
} from './oauth.service.js';

const MAX_USER_ID_LENGTH = 100;

const decisionBodySchema = z.strictObject({ approve: z.boolean() });

const listInScopeQuerySchema = z.object({
  ...paginationQueryFields,
  userId: z.string().trim().min(1).max(MAX_USER_ID_LENGTH).optional(),
});

const handleGetRequest: RequestHandler = async (req, res) => {
  res.json(await getAuthorizationRequest(String(req.params.id)));
};

const handleDecide: RequestHandler = async (req, res) => {
  const { approve } = parseRequestBody(decisionBodySchema, req.body);
  res.set('Cache-Control', 'no-store').json(await decideAuthorizationRequest(getCaller(req), String(req.params.id), approve, req.ip));
};

const handleListConnectedApps: RequestHandler = async (req, res) => {
  res.json({ apps: await listConnectedApps(getCaller(req).user._id) });
};

const handleRevokeConnectedApp: RequestHandler = async (req, res) => {
  res.json(await revokeConnectedApp(getCaller(req), String(req.params.id), req.ip));
};

const handleListInScope: RequestHandler = async (req, res) => {
  res.json(await listConnectedAppsInScope(getActor(req), getPermissionScope(req), parseRequestQuery(listInScopeQuerySchema, req.query)));
};

const handleRevokeInScope: RequestHandler = async (req, res) => {
  res.json(await revokeConnectedAppInScope(getActor(req), getPermissionScope(req), String(req.params.id)));
};

/**
 * The portal's side of OAuth: the consent page, the person's own connected apps, and an admin's view of everyone's.
 * Approving a request needs apiToken.create, checked in the service, because declining must always work.
 * A person can always see and disconnect their own apps.
 */
export const oauthRoutes: ApiRoute[] = [
  { method: 'GET', path: '/oauth/requests/:id', access: 'signed', handler: handleGetRequest },
  { method: 'POST', path: '/oauth/requests/:id/decision', access: 'signed', handler: handleDecide },
  { method: 'GET', path: '/me/connected-apps', access: 'signed', handler: handleListConnectedApps },
  { method: 'POST', path: '/me/connected-apps/:id/revoke', access: 'signed', handler: handleRevokeConnectedApp },
  { method: 'GET', path: '/connected-apps', access: 'private', permission: 'apiToken.read', handler: handleListInScope },
  { method: 'POST', path: '/connected-apps/:id/revoke', access: 'private', permission: 'apiToken.delete', handler: handleRevokeInScope },
];
