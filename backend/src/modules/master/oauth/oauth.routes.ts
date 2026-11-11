import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../access/caller.js';
import { decideAuthorizationRequest, getAuthorizationRequest, listConnectedApps, revokeConnectedApp } from './oauth.service.js';

const decisionBodySchema = z.strictObject({ approve: z.boolean() });

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

/**
 * The portal's side of OAuth: the consent page, and the person's own connected apps. Signed routes, because anyone
 * may connect an app, and it can only ever act with their own access.
 */
export const oauthRoutes: ApiRoute[] = [
  { method: 'GET', path: '/oauth/requests/:id', access: 'signed', handler: handleGetRequest },
  { method: 'POST', path: '/oauth/requests/:id/decision', access: 'signed', handler: handleDecide },
  { method: 'GET', path: '/me/connected-apps', access: 'signed', handler: handleListConnectedApps },
  { method: 'POST', path: '/me/connected-apps/:id/revoke', access: 'signed', handler: handleRevokeConnectedApp },
];
