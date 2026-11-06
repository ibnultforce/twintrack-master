import type { RequestHandler } from 'express';
import { isDatabaseConnected } from '../../../db.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';

const getHealth: RequestHandler = (_req, res) => {
  const isConnected = isDatabaseConnected();
  res.status(isConnected ? 200 : 503).json({
    status: isConnected ? 'ok' : 'unavailable',
    database: isConnected ? 'connected' : 'disconnected',
  });
};

export const healthRoutes: ApiRoute[] = [{ method: 'GET', path: '/health', access: 'public', handler: getHealth }];
