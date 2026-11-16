import type { RequestHandler } from 'express';
import { isDatabaseConnected } from '../../../db.js';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';

const getHealth: RequestHandler = (_req, res) => {
  const isConnected = isDatabaseConnected();
  res.status(isConnected ? 200 : 503).json({
    status: isConnected ? 'ok' : 'unavailable',
    database: isConnected ? 'connected' : 'disconnected',
  });
};

/**
 * Says the API itself is answering, whatever the database is doing, and which commit it runs, so anyone can
 * compare the live server with the latest commit on main. `commit` is null where nothing deployed it.
 */
const createApiCheck = (deployedCommit: string | undefined): RequestHandler => (_req, res) => {
  res.json({ status: 'ok', module: MASTER_MODULE_KEY, commit: deployedCommit ?? null, time: new Date().toISOString() });
};

export const createHealthRoutes = (config: Pick<Config, 'deployedCommit'>): ApiRoute[] => [
  { method: 'GET', path: '/health', access: 'public', handler: getHealth },
  { method: 'GET', path: '/api-check', access: 'public', handler: createApiCheck(config.deployedCommit) },
];
