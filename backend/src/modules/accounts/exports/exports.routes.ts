import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField } from '../accountsFields.js';
import { EXPORT_PERMISSIONS } from './exportDatasets.js';
import { exportDataset, listExports } from './exports.service.js';

const exportQuerySchema = z
  .object({ from: accountingDateField.optional(), to: accountingDateField.optional(), year: z.coerce.number().int().min(2000).max(2100).optional() })
  .refine(({ from, to }) => !from || !to || from <= to, { message: 'from must be on or before to', path: ['to'] });
const datasetParamSchema = z.object({ dataset: z.string().regex(/^[a-z-]{1,60}$/, 'must name an export') });

const handleList: RequestHandler = async (req, res) => {
  res.json(await listExports(getActor(req)));
};
const handleExport: RequestHandler = async (req, res) => {
  const { dataset } = parseRequestQuery(datasetParamSchema, req.params);
  const { fileName, csv } = await exportDataset(getActor(req), dataset, parseRequestQuery(exportQuerySchema, req.query));
  res.attachment(fileName).type('text/csv; charset=utf-8').send(csv);
};

/**
 * The Export center. Open to anyone who can read at least one exportable list or report; the service checks the
 * chosen dataset's own permission and drops columns for fields the person's profile hides.
 */
export const exportRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/exports', access: 'private', anyPermission: EXPORT_PERMISSIONS, handler: handleList },
  { method: 'GET', path: '/accounts/exports/:dataset', access: 'private', anyPermission: EXPORT_PERMISSIONS, handler: handleExport },
];
