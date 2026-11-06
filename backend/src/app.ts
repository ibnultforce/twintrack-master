import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { registerRoutes } from './lib/apiRoute.js';
import { ApiError } from './lib/errors.js';
import { createRequestLogger } from './lib/requestLogger.js';
import { createMasterRoutes } from './modules/master/master.routes.js';

export function createApp(config: Config) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(createRequestLogger(config.logLevel));
  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  registerRoutes(app, createMasterRoutes(config));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'no_route', message: 'No such route.' } });
  });

  app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
      return;
    }
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
