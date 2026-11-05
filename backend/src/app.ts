import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import { isDatabaseConnected } from './db.js';

export function createApp(config: Config) {
  const app = express();

  app.disable('x-powered-by');
  app.use(pinoHttp({ level: config.logLevel }));
  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    const connected = isDatabaseConnected();
    res.status(connected ? 200 : 503).json({
      status: connected ? 'ok' : 'unavailable',
      database: connected ? 'connected' : 'disconnected',
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'no_route', message: 'No such route.' } });
  });

  app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) req.log.error(err);
    res.status(status).json({
      error: {
        code: status === 500 ? 'server_error' : 'bad_request',
        message: status === 500 ? 'Something went wrong.' : 'The request could not be read.',
      },
    });
  });

  return app;
}
