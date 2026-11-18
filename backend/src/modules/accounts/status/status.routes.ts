import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';

/**
 * A first, read-only route that proves the Accounts module is registered and its permissions are enforced.
 * It reads no data, so it is safe to call while the ledger and other features are still being built.
 */
const handleStatus: RequestHandler = (_req, res) => {
  res.json({ module: 'accounts', status: 'ok', time: new Date().toISOString() });
};

export const statusRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/status', access: 'private', permission: 'setting.read', handler: handleStatus },
];
