import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { API_TEST_MODULE_KEY } from '../apiTestModule.js';

/** Says the caller reached the API Test module and holds its test.read permission. */
const getTest: RequestHandler = (_req, res) => {
  res.json({ status: 'ok', module: API_TEST_MODULE_KEY, time: new Date().toISOString() });
};

export const testRoutes: ApiRoute[] = [{ method: 'GET', path: '/api-test/test', access: 'private', permission: 'test.read', handler: getTest }];
