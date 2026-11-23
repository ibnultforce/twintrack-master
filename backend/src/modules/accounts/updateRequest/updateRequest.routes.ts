import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { CORRECTABLE_RECORD_TYPES, UPDATE_REQUEST_STATUSES } from '../models/updateRequest.js';
import { approveUpdateRequest, createUpdateRequest, getUpdateRequest, listUpdateRequests, rejectUpdateRequest } from './updateRequest.service.js';

const MAX_LINES = 200;
const MAX_MEMO_LENGTH = 500;
const MAX_REASON_LENGTH = 1000;

const lineSchema = z.strictObject({
  accountId: recordIdField,
  debit: minorUnitsField.optional(),
  credit: minorUnitsField.optional(),
  memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(),
});

const changesSchema = z
  .strictObject({
    voucherDate: accountingDateField.optional(),
    memo: z.string().trim().min(1, 'is required').max(MAX_MEMO_LENGTH).optional(),
    lines: z.array(lineSchema).min(2, 'needs at least 2 lines').max(MAX_LINES).optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, { message: 'send at least one of voucherDate, memo or lines' });

const createBodySchema = z.strictObject({
  recordType: z.enum(CORRECTABLE_RECORD_TYPES),
  recordId: recordIdField,
  reason: z.string().trim().min(1, 'say what is wrong').max(MAX_REASON_LENGTH),
  changes: changesSchema,
});

const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(UPDATE_REQUEST_STATUSES).optional(), recordId: recordIdField.optional() });
const approveBodySchema = z.strictObject({ version: versionField.optional() });
const rejectBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say why').max(MAX_REASON_LENGTH), version: versionField.optional() });

const requestId = (req: Request) => String(req.params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listUpdateRequests(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getUpdateRequest(getActor(req), requestId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createUpdateRequest(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveUpdateRequest(getActor(req), requestId(req), parseRequestBody(approveBodySchema, req.body ?? {}).version));
};
const handleReject: RequestHandler = async (req, res) => {
  res.json(await rejectUpdateRequest(getActor(req), requestId(req), parseRequestBody(rejectBodySchema, req.body)));
};

const BASE = '/accounts/update-requests';

/**
 * Update requests: the only way a recorded voucher changes. Approve and reject need only read access at the route,
 * because the stand-in approver may decide without the approve permission; the service checks the approve permission
 * or stand-in, and refuses the requester.
 */
export const updateRequestRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'updateRequest.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'updateRequest.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'updateRequest.read', handler: handleGet },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'updateRequest.read', bodySchema: approveBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/reject`, access: 'private', permission: 'updateRequest.read', bodySchema: rejectBodySchema, handler: handleReject },
];
