import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, recordIdField, versionField } from '../accountsFields.js';
import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { PAYROLL_RUN_STATUSES } from '../models/payrollRun.js';
import {
  approvePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  findSubmittedPayrollRuns,
  getPayrollRun,
  getPayrollRunHistory,
  listPayrollRuns,
  monthLabel,
  payPayrollRun,
  returnPayrollRun,
  submitPayrollRun,
  updatePayrollRun,
} from './payroll.service.js';

const MAX_NOTE = 1000;
const MAX_ADJUSTMENTS = 500;

const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month as YYYY-MM');
const reasonField = z.string().trim().min(1, 'say why').max(MAX_NOTE);

const createBodySchema = z.strictObject({ month: monthField, payDate: accountingDateField });

const updateBodySchema = z
  .strictObject({
    payDate: accountingDateField.optional(),
    adjustments: z.array(z.strictObject({
      employeeId: recordIdField,
      // Paisa; 0 takes the person off this run.
      gross: minorUnitsField,
      note: z.string().trim().max(200).optional(),
    })).min(1).max(MAX_ADJUSTMENTS).optional(),
    reason: reasonField,
    version: versionField.optional(),
  })
  .refine(({ payDate, adjustments }) => payDate !== undefined || adjustments !== undefined, { message: 'send a pay date or adjustments' });

const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE), version: versionField.optional() });
const cancelBodySchema = z.strictObject({ reason: reasonField, version: versionField.optional() });
const payBodySchema = z.strictObject({
  paymentDate: accountingDateField,
  moneyAccountId: recordIdField,
  amount: minorUnitsField.min(1, 'must be above zero').optional(),
  reference: z.string().trim().max(100).optional(),
});
const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(PAYROLL_RUN_STATUSES).optional() });

const runId = (req: Request) => String(req.params.id);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listPayrollRuns(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getPayrollRun(getActor(req), runId(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createPayrollRun(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updatePayrollRun(getActor(req), runId(req), parseRequestBody(updateBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitPayrollRun(getActor(req), runId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approvePayrollRun(getActor(req), runId(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnPayrollRun(getActor(req), runId(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleCancel: RequestHandler = async (req, res) => {
  res.json(await cancelPayrollRun(getActor(req), runId(req), parseRequestBody(cancelBodySchema, req.body)));
};
const handlePay: RequestHandler = async (req, res) => {
  res.status(201).json(await payPayrollRun(getActor(req), runId(req), parseRequestBody(payBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getPayrollRunHistory(getActor(req), runId(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};

const BASE = '/accounts/payroll-runs';

/**
 * Monthly payroll on the dummy employees until HR is built: draft, submitted, recorded (salary expense against
 * salaries payable), cancelled. Per-person salaries are the protected `lines` field. Approve, return and cancel need
 * only read access at the route, because the stand-in may decide; the service refuses the run's maker.
 */
export const payrollRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'payrollRun.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'payrollRun.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'payrollRun.read', handler: handleGet },
  { method: 'PATCH', path: `${BASE}/:id`, access: 'private', permission: 'payrollRun.update', bodySchema: updateBodySchema, handler: handleUpdate },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'payrollRun.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'payrollRun.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'payrollRun.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/cancel`, access: 'private', permission: 'payrollRun.read', bodySchema: cancelBodySchema, handler: handleCancel },
  { method: 'POST', path: `${BASE}/:id/pay`, access: 'private', permission: 'journalVoucher.create', bodySchema: payBodySchema, handler: handlePay },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'payrollRun.read', handler: handleHistory },
];

/** Payroll runs waiting for approval, for the Approvals queue. */
export const payrollApprovals: ApprovalSource = {
  type: 'payrollRun',
  readPermission: 'payrollRun.read',
  approvePermission: 'payrollRun.approve',
  async findWaiting(creator, limit) {
    const { runs, total } = await findSubmittedPayrollRuns(creator, limit);
    return {
      total,
      records: runs.map((run) => ({
        id: run._id,
        number: run.number,
        title: `Salaries, ${monthLabel(run.month)}`,
        amount: run.total,
        date: run.payDate,
        createdBy: run.createdBy,
        submittedAt: run.submittedAt,
      })),
    };
  },
};
