import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { NEW_TEST_MODULE_KEY } from '../newTestModule.js';

/** Says the caller reached the New test module and holds its test.read permission. */
const getTest: RequestHandler = (_req, res) => {
  res.json({ status: 'ok', module: NEW_TEST_MODULE_KEY, time: new Date().toISOString() });
};

export const testRoutes: ApiRoute[] = [{ method: 'GET', path: '/new-test/test', access: 'private', permission: 'test.read', handler: getTest }];
