import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { JOURNAL_VOUCHER_STATUSES } from '../models/journalVoucher.js';
import {
  approveJournalVoucher,
  createJournalVoucher,
  getJournalVoucher,
  getJournalVoucherHistory,
  listJournalVouchers,
  returnJournalVoucher,
  reverseJournalVoucher,
  submitJournalVoucher,
  updateJournalVoucher,
} from './journalVoucher.service.js';

const MAX_LINES = 200;
const MAX_MEMO_LENGTH = 500;
const MAX_NOTE_LENGTH = 1000;

const lineSchema = z.strictObject({
  accountId: recordIdField,
  debit: minorUnitsField.optional(),
  credit: minorUnitsField.optional(),
  memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(),
});

const memoField = z.string().trim().min(1, 'is required').max(MAX_MEMO_LENGTH);
const linesField = z.array(lineSchema).min(2, 'needs at least 2 lines').max(MAX_LINES);

const MAX_SEARCH_LENGTH = 100;

const listQuerySchema = z
  .object({
    ...paginationQueryFields,
    status: z.enum(JOURNAL_VOUCHER_STATUSES).optional(),
    from: accountingDateField.optional(),
    to: accountingDateField.optional(),
    search: z.string().trim().max(MAX_SEARCH_LENGTH).optional().transform((text) => text || undefined),
  })
  .refine(({ from, to }) => !from || !to || from <= to, { message: 'from must be on or before to', path: ['to'] });

const createBodySchema = z.strictObject({ voucherDate: accountingDateField, memo: memoField, lines: linesField });

const updateBodySchema = z
  .strictObject({ voucherDate: accountingDateField.optional(), memo: memoField.optional(), lines: linesField.optional(), version: versionField.optional() })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE_LENGTH), version: versionField.optional() });
const reverseBodySchema = z.strictObject({ memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(), version: versionField.optional() });

const voucherId = (req: Request) => String(req.params.id);
// Decisions take an optional body; an empty request is fine.
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listJournalVouchers(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getJournalVoucher(getActor(req), voucherId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createJournalVoucher(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateJournalVoucher(getActor(req), voucherId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitJournalVoucher(getActor(req), voucherId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveJournalVoucher(getActor(req), voucherId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnJournalVoucher(getActor(req), voucherId(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleReverse: RequestHandler = async (req, res) => {
  res.json(await reverseJournalVoucher(getActor(req), voucherId(req), parseRequestBody(reverseBodySchema, bodyOf(req))));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getJournalVoucherHistory(getActor(req), voucherId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const BASE = '/accounts/journal-vouchers';

/**
 * Journal vouchers: draft, submitted, recorded (written to the ledger), reversed. Approve, return and reverse need only
 * read access at the route, because the stand-in approver from Settings may decide without the approve permission;
 * the service checks the approve permission or stand-in, and refuses the voucher's maker.
 */
export const journalVoucherRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'journalVoucher.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'journalVoucher.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'journalVoucher.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'journalVoucher.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'journalVoucher.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'journalVoucher.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'journalVoucher.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/reverse`, access: 'private', permission: 'journalVoucher.read', bodySchema: reverseBodySchema, handler: handleReverse },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'journalVoucher.read', handler: handleHistory },
];
