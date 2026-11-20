import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { listActivity } from '../../master/audit/audit.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';

const MAX_ACTION_PREFIX_LENGTH = 50;

const listQuerySchema = z.object({
  ...paginationQueryFields,
  actionPrefix: z.string().max(MAX_ACTION_PREFIX_LENGTH).regex(/^[a-zA-Z_.]+$/, 'must be the start of an action, such as "journalVoucher."').optional(),
});

/** The activity log, limited to what the Accounts module wrote. Master's own /audit needs a Master permission. */
const handleList: RequestHandler = async (req, res) => {
  res.json(await listActivity({ ...parseRequestQuery(listQuerySchema, req.query), module: ACCOUNTS_MODULE_KEY }));
};

export const auditLogRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/audit-log', access: 'private', permission: 'auditLog.read', handler: handleList },
];
