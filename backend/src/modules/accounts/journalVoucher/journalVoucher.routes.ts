import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import { JOURNAL_VOUCHER_STATUSES, VOUCHER_TYPES } from '../models/journalVoucher.js';
import {
  approveJournalVoucher,
  createJournalVoucher,
  createMoneyVoucher,
  getJournalVoucher,
  getJournalVoucherHistory,
  listJournalVouchers,
  returnJournalVoucher,
  reverseJournalVoucher,
  submitJournalVoucher,
  updateJournalVoucher,
  updateMoneyVoucher,
} from './journalVoucher.service.js';
import type { MoneyVoucherType } from './moneyVoucher.js';

const MAX_LINES = 200;
const MAX_MEMO_LENGTH = 500;
const MAX_NOTE_LENGTH = 1000;
const MAX_PARTY_LENGTH = 200;
const MAX_REFERENCE_LENGTH = 100;

const lineSchema = z.strictObject({
  accountId: recordIdField,
  debit: minorUnitsField.optional(),
  credit: minorUnitsField.optional(),
  memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(),
});

const memoField = z.string().trim().min(1, 'is required').max(MAX_MEMO_LENGTH);
const linesField = z.array(lineSchema).min(2, 'needs at least 2 lines').max(MAX_LINES);
// An empty party or reference on an edit removes it.
const partyField = z.string().trim().max(MAX_PARTY_LENGTH);
const requiredPartyField = partyField.min(1, 'say who was paid or who paid');
const referenceField = z.string().trim().max(MAX_REFERENCE_LENGTH);
const reasonField = z.string().trim().min(1, 'say why you are changing it').max(MAX_NOTE_LENGTH);

/** One thing a payment paid for, or a receipt was received for. The cash or bank line is added by the API. */
const moneyItemSchema = z.strictObject({
  accountId: recordIdField,
  amount: minorUnitsField.min(1, 'must be above zero'),
  memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(),
});
const moneyItemsField = z.array(moneyItemSchema).min(1, 'needs at least 1 line').max(MAX_LINES - 1);

const atLeastOneChange = ({ version: _version, reason: _reason, ...changes }: { version?: number; reason: string }) => Object.keys(changes).length > 0;
const NO_CHANGE = { message: 'send at least one field to change' };

const MAX_SEARCH_LENGTH = 100;

const listQuerySchema = z
  .object({
    ...paginationQueryFields,
    type: z.enum(VOUCHER_TYPES).optional(),
    status: z.enum(JOURNAL_VOUCHER_STATUSES).optional(),
    from: accountingDateField.optional(),
    to: accountingDateField.optional(),
    search: z.string().trim().max(MAX_SEARCH_LENGTH).optional().transform((text) => text || undefined),
  })
  .refine(({ from, to }) => !from || !to || from <= to, { message: 'from must be on or before to', path: ['to'] });

const createBodySchema = z.strictObject({
  voucherDate: accountingDateField,
  memo: memoField,
  party: partyField.optional(),
  reference: referenceField.optional(),
  lines: linesField,
});

const updateBodySchema = z
  .strictObject({
    voucherDate: accountingDateField.optional(),
    memo: memoField.optional(),
    party: partyField.optional(),
    reference: referenceField.optional(),
    lines: linesField.optional(),
    reason: reasonField,
    version: versionField.optional(),
  })
  .refine(atLeastOneChange, NO_CHANGE);

const createMoneyBodySchema = z.strictObject({
  voucherDate: accountingDateField,
  memo: memoField,
  party: requiredPartyField,
  reference: referenceField.optional(),
  moneyAccountId: recordIdField,
  lines: moneyItemsField,
});

const updateMoneyBodySchema = z
  .strictObject({
    voucherDate: accountingDateField.optional(),
    memo: memoField.optional(),
    party: requiredPartyField.optional(),
    reference: referenceField.optional(),
    moneyAccountId: recordIdField.optional(),
    lines: moneyItemsField.optional(),
    reason: reasonField,
    version: versionField.optional(),
  })
  .refine(atLeastOneChange, NO_CHANGE);

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE_LENGTH), version: versionField.optional() });
const reverseBodySchema = z.strictObject({ memo: z.string().trim().max(MAX_MEMO_LENGTH).optional(), version: versionField.optional() });

const voucherId = (req: Request) => String(req.params.id);
// Decisions take an optional body; an empty request is fine.
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  const { type: voucherType, ...query } = parseRequestQuery(listQuerySchema, req.query);
  res.json(await listJournalVouchers(getActor(req), { ...query, voucherType }));
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
const handleCreateMoney = (voucherType: MoneyVoucherType): RequestHandler => async (req, res) => {
  res.status(201).json(await createMoneyVoucher(getActor(req), voucherType, parseRequestBody(createMoneyBodySchema, req.body)));
};
const handleUpdateMoney = (voucherType: MoneyVoucherType): RequestHandler => async (req, res) => {
  res.json(await updateMoneyVoucher(getActor(req), voucherType, voucherId(req), parseRequestBody(updateMoneyBodySchema, req.body)));
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
const PAYMENT_BASE = '/accounts/payment-vouchers';
const RECEIPT_BASE = '/accounts/receipt-vouchers';

/**
 * Vouchers of every type: draft, submitted, recorded (written to the ledger), reversed. Payment and receipt vouchers
 * are made and edited on their own paths, because they take a cash or bank account and items instead of full lines;
 * everything else, for every type, is on the journal voucher paths. Approve, return and reverse need only
 * read access at the route, because the stand-in approver from Settings may decide without the approve permission;
 * the service checks the approve permission or stand-in, and refuses the voucher's maker.
 */
export const journalVoucherRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'journalVoucher.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'journalVoucher.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'journalVoucher.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'journalVoucher.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: PAYMENT_BASE, access: 'private', permission: 'journalVoucher.create', bodySchema: createMoneyBodySchema, handler: handleCreateMoney('payment') },
  { method: 'PATCH', path: `${PAYMENT_BASE}/:id`, access: 'private', permission: 'journalVoucher.update', bodySchema: updateMoneyBodySchema, handler: handleUpdateMoney('payment') },
  { method: 'POST', path: RECEIPT_BASE, access: 'private', permission: 'journalVoucher.create', bodySchema: createMoneyBodySchema, handler: handleCreateMoney('receipt') },
  { method: 'PATCH', path: `${RECEIPT_BASE}/:id`, access: 'private', permission: 'journalVoucher.update', bodySchema: updateMoneyBodySchema, handler: handleUpdateMoney('receipt') },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'journalVoucher.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'journalVoucher.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'journalVoucher.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/reverse`, access: 'private', permission: 'journalVoucher.read', bodySchema: reverseBodySchema, handler: handleReverse },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'journalVoucher.read', handler: handleHistory },
];
