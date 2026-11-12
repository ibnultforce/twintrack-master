import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { resolveDependencies, type AppDependencies } from './appDependencies.js';
import type { Config } from './config.js';
import { registerRoutes } from './lib/apiRoute.js';
import { LOCAL_PART_PATH } from './lib/storage/localStorage.js';
import { handleApiError } from './lib/errorHandler.js';
import { createRequestLogger } from './lib/requestLogger.js';
import { serveTestPage } from './lib/testPage.js';
import { HR_MODULE_KEY, hrRoutes } from './modules/hr/hr.routes.js';
import { hrUserReferenceChecks } from './modules/hr/hrUserReferences.js';
import { createTasksRoutes, TASKS_MODULE_KEY } from './modules/tasks/tasks.routes.js';
import { tasksMcpTools } from './modules/tasks/tasksMcpTools.js';
import { tasksUserReferenceChecks } from './modules/tasks/tasksUserReferences.js';
import { createAccessMiddleware } from './modules/master/access/access.middleware.js';
import { createMasterRoutes, MASTER_MODULE_KEY, mountMasterProtocols } from './modules/master/master.routes.js';
import { OAUTH_PROTOCOL_PATH } from './modules/master/oauth/oauthProtocol.js';

/**
 * Paths apps call directly, such as Claude connecting over MCP. Any origin may call them, because they authenticate
 * with bearer tokens, never the portal's cookie.
 */
const isAppProtocolPath = (path: string) => path === '/mcp' || OAUTH_PROTOCOL_PATH.test(path);

export function createApp(config: Config, dependencyOverrides: Partial<AppDependencies> = {}) {
  const dependencies = resolveDependencies(config, dependencyOverrides);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(createRequestLogger(config.logLevel));
  app.use(helmet());
  const portalCors = cors({ origin: config.allowedOrigins, credentials: true });
  const appProtocolCors = cors({ exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] });
  app.use((req, res, next) => (isAppProtocolPath(req.path) ? appProtocolCors : portalCors)(req, res, next));
  const parseJson = express.json({ limit: '256kb' });
  // Upload parts are file bytes streamed to storage, whatever type the file is, so they are never parsed.
  app.use((req, res, next) => (req.path === LOCAL_PART_PATH ? next() : parseJson(req, res, next)));
  app.use(cookieParser());

  if (config.isTestPageEnabled) serveTestPage(app);
  mountMasterProtocols(app, config);
  const masterExtensions = { userReferenceChecks: [...hrUserReferenceChecks, ...tasksUserReferenceChecks], mcpToolProviders: [tasksMcpTools] };
  registerRoutes(app, createMasterRoutes(config, dependencies, masterExtensions), createAccessMiddleware(config.auth, MASTER_MODULE_KEY));
  registerRoutes(app, hrRoutes, createAccessMiddleware(config.auth, HR_MODULE_KEY));
  registerRoutes(app, createTasksRoutes(config, dependencies), createAccessMiddleware(config.auth, TASKS_MODULE_KEY));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'no_route', message: 'No such route.' } });
  });
  app.use(handleApiError);

  return app;
}
