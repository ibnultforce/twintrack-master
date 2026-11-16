import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { TEST_MODULE_KEY } from '../testModule.js';

/** Says the caller reached the Test module and holds its test.read permission. Reads no module data. */
const getStatus: RequestHandler = (_req, res) => {
  res.json({ status: 'ok', module: TEST_MODULE_KEY, time: new Date().toISOString() });
};

export const statusRoutes: ApiRoute[] = [{ method: 'GET', path: '/test', access: 'private', permission: 'test.read', handler: getStatus }];
