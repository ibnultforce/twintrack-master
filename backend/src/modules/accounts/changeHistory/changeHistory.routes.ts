import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getActor } from '../../master/access/caller.js';
import { listChangeHistory } from './changeHistory.service.js';

const handleList: RequestHandler = async (req, res) => {
  res.json(await listChangeHistory(getActor(req)));
};

/** Open to anyone who can read vouchers or update requests; the service shows only the kinds they can read. */
export const changeHistoryRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/change-history', access: 'private', anyPermission: ['journalVoucher.read', 'updateRequest.read'], handler: handleList },
];
