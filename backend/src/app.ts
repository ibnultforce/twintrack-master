import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { registerRoutes } from './lib/apiRoute.js';
import { handleApiError } from './lib/errorHandler.js';
import { createRequestLogger } from './lib/requestLogger.js';
import { serveTestPage } from './lib/testPage.js';
import { HR_MODULE_KEY, hrRoutes } from './modules/hr/hr.routes.js';
import { TASKS_MODULE_KEY, tasksRoutes } from './modules/tasks/tasks.routes.js';
import { createAccessMiddleware } from './modules/master/access/access.middleware.js';
import { createMasterRoutes, MASTER_MODULE_KEY } from './modules/master/master.routes.js';

export function createApp(config: Config) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(createRequestLogger(config.logLevel));
  app.use(helmet());
  app.use(cors({ origin: config.allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  if (config.isTestPageEnabled) serveTestPage(app);
  registerRoutes(app, createMasterRoutes(config), createAccessMiddleware(config.auth, MASTER_MODULE_KEY));
  registerRoutes(app, hrRoutes, createAccessMiddleware(config.auth, HR_MODULE_KEY));
  registerRoutes(app, tasksRoutes, createAccessMiddleware(config.auth, TASKS_MODULE_KEY));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'no_route', message: 'No such route.' } });
  });
  app.use(handleApiError);

  return app;
}
