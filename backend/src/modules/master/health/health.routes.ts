import type { RequestHandler } from 'express';
import { isDatabaseConnected } from '../../../db.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';

const getHealth: RequestHandler = (_req, res) => {
  const isConnected = isDatabaseConnected();
  res.status(isConnected ? 200 : 503).json({
    status: isConnected ? 'ok' : 'unavailable',
    database: isConnected ? 'connected' : 'disconnected',
  });
};

/** Says the API itself is answering, whatever the database is doing. */
const getApiCheck: RequestHandler = (_req, res) => {
  res.json({ status: 'ok', module: MASTER_MODULE_KEY, time: new Date().toISOString() });
};

export const healthRoutes: ApiRoute[] = [
  { method: 'GET', path: '/health', access: 'public', handler: getHealth },
  { method: 'GET', path: '/api-check', access: 'public', handler: getApiCheck },
];
