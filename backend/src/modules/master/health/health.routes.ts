import type { Application } from 'express';
import { isDatabaseConnected } from '../../../db.js';

export function registerHealthRoutes(app: Application): void {
  app.get('/health', (_req, res) => {
    const isConnected = isDatabaseConnected();
    res.status(isConnected ? 200 : 503).json({
      status: isConnected ? 'ok' : 'unavailable',
      database: isConnected ? 'connected' : 'disconnected',
    });
  });
}
