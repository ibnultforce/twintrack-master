import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { NEW_TEST_MODULE_KEY } from '../newTestModule.js';

/** Says the New test module's routes are answering. Public, and reads no module data. */
const getHealth: RequestHandler = (_req, res) => {
  res.json({ status: 'ok', module: NEW_TEST_MODULE_KEY, time: new Date().toISOString() });
};

export const healthRoutes: ApiRoute[] = [{ method: 'GET', path: '/new-test/health', access: 'public', handler: getHealth }];
