import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { PAYOUT_KINDS, PAYOUT_STATUSES } from '../models/staffPayout.js';
import { createCommissionRule, listCommissions, updateCommissionRule } from './commissions.js';
import { listEmployeePayments } from './employeePayments.js';
import {
  approveStaffPayout,
  cancelStaffPayout,
  createStaffPayout,
  findSubmittedStaffPayouts,
  getStaffPayout,
  getStaffPayoutHistory,
  listStaffPayouts,
  payStaffPayout,
  returnStaffPayout,
  submitStaffPayout,
} from './staffPayout.service.js';

const MAX_NOTE = 1000;
const MAX_LINES = 500;
/** 100%: no commission is above the money received. */
const MAX_BASIS_POINTS = 10_000;

const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month as YYYY-MM');

const createBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('incentive'), month: monthField, payDate: accountingDateField }),
  z.strictObject({
    kind: z.literal('bonus'),
    title: z.string().trim().min(1, 'is required').max(200),
    payDate: accountingDateField,
    lines: z.array(z.strictObject({ employeeId: recordIdField, amount: minorUnitsField.min(1, 'must be above zero'), note: z.string().trim().max(200).optional() })).min(1).max(MAX_LINES),
  }),
  z.strictObject({ kind: z.literal('commission'), payDate: accountingDateField }),
]);

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE), version: versionField.optional() });
const cancelBodySchema = z.strictObject({ reason: z.string().trim().min(1, 'say why').max(MAX_NOTE), version: versionField.optional() });
const payBodySchema = z.strictObject({ paymentDate: accountingDateField, moneyAccountId: recordIdField, amount: minorUnitsField.min(1).optional(), reference: z.string().trim().max(100).optional() });
const listQuerySchema = z.object({ ...paginationQueryFields, kind: z.enum(PAYOUT_KINDS).optional(), status: z.enum(PAYOUT_STATUSES).optional() });

const ruleBodySchema = z.strictObject({ employeeId: recordIdField, clientId: recordIdField, rateBasisPoints: z.number().int().min(1).max(MAX_BASIS_POINTS), startDate: accountingDateField });
const ruleUpdateSchema = z
  .strictObject({ rateBasisPoints: z.number().int().min(1).max(MAX_BASIS_POINTS).optional(), startDate: accountingDateField.optional(), isActive: z.boolean().optional(), version: versionField.optional() })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const paymentsQuerySchema = z.object({ employeeId: recordIdField.optional(), from: accountingDateField.optional(), to: accountingDateField.optional() });

const idOf = (req: Request) => String(req.params.id);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listStaffPayouts(parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getStaffPayout(getActor(req), idOf(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createStaffPayout(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitStaffPayout(getActor(req), idOf(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveStaffPayout(getActor(req), idOf(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnStaffPayout(getActor(req), idOf(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleCancel: RequestHandler = async (req, res) => {
  res.json(await cancelStaffPayout(getActor(req), idOf(req), parseRequestBody(cancelBodySchema, req.body)));
};
const handlePay: RequestHandler = async (req, res) => {
  res.status(201).json(await payStaffPayout(getActor(req), idOf(req), parseRequestBody(payBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getStaffPayoutHistory(idOf(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};
const handleCommissions: RequestHandler = async (_req, res) => {
  res.json(await listCommissions());
};
const handleCreateRule: RequestHandler = async (req, res) => {
  res.status(201).json(await createCommissionRule(getActor(req), parseRequestBody(ruleBodySchema, req.body)));
};
const handleUpdateRule: RequestHandler = async (req, res) => {
  res.json(await updateCommissionRule(getActor(req), idOf(req), parseRequestBody(ruleUpdateSchema, req.body)));
};
const handleEmployeePayments: RequestHandler = async (req, res) => {
  res.json(await listEmployeePayments(getActor(req), parseRequestQuery(paymentsQuerySchema, req.query)));
};

const BASE = '/accounts/staff-payouts';

/**
 * Bonus, incentive and commission payouts (approve, return and cancel are decided in the service, never by the
 * maker), commission rules and what they earned, and what each employee received. Employee payments opens to anyone
 * who reads payroll or payouts; the service shows only what each may see.
 */
export const staffPayoutRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'staffPayout.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'staffPayout.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'staffPayout.read', handler: handleGet },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'staffPayout.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'staffPayout.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'staffPayout.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/cancel`, access: 'private', permission: 'staffPayout.read', bodySchema: cancelBodySchema, handler: handleCancel },
  { method: 'POST', path: `${BASE}/:id/pay`, access: 'private', permission: 'journalVoucher.create', bodySchema: payBodySchema, handler: handlePay },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'staffPayout.read', handler: handleHistory },
  { method: 'GET', path: '/accounts/commission-rules', access: 'private', permission: 'commissionRule.read', handler: handleCommissions },
  { method: 'POST', path: '/accounts/commission-rules', access: 'private', permission: 'commissionRule.create', bodySchema: ruleBodySchema, handler: handleCreateRule },
  { method: 'PATCH', path: '/accounts/commission-rules/:id', access: 'private', permission: 'commissionRule.update', bodySchema: ruleUpdateSchema, handler: handleUpdateRule },
  { method: 'GET', path: '/accounts/employee-payments', access: 'private', anyPermission: ['payrollRun.read', 'staffPayout.read'], handler: handleEmployeePayments },
];

export const staffPayoutApprovals: ApprovalSource = {
  type: 'staffPayout',
  readPermission: 'staffPayout.read',
  approvePermission: 'staffPayout.approve',
  async findWaiting(creator, limit) {
    const { payouts, total } = await findSubmittedStaffPayouts(creator, limit);
    return { total, records: payouts.map((payout) => ({ id: payout._id, number: payout.number, title: payout.title, amount: payout.total, date: payout.payDate, createdBy: payout.createdBy, submittedAt: payout.submittedAt })) };
  },
};
