import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { accountingDateField, minorUnitsField, monthField, recordIdField, versionField } from '../accountsFields.js';
import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { LOAN_KINDS, LOAN_STATUSES } from '../models/employeeLoan.js';
import {
  approveEmployeeLoan,
  cancelEmployeeLoan,
  createEmployeeLoan,
  findSubmittedEmployeeLoans,
  getEmployeeLoan,
  getEmployeeLoanHistory,
  listEmployeeLoans,
  listUnpaidLeave,
  payEmployeeLoan,
  returnEmployeeLoan,
  setUnpaidLeave,
  submitEmployeeLoan,
} from './employeeLoan.service.js';

const MAX_NOTE = 1000;
/** A month's unpaid leave can't be more days than the month has. */
const MAX_LEAVE_DAYS = 31;

const createBodySchema = z.strictObject({
  employeeId: recordIdField,
  kind: z.enum(LOAN_KINDS),
  purpose: z.string().trim().min(1, 'is required').max(200),
  issueDate: accountingDateField,
  amount: minorUnitsField.min(1, 'must be above zero'),
  monthlyInstallment: minorUnitsField.min(1, 'must be above zero'),
  firstRepaymentMonth: monthField,
});
const decisionBodySchema = z.strictObject({ version: versionField.optional() });
const returnBodySchema = z.strictObject({ note: z.string().trim().min(1, 'say what needs fixing').max(MAX_NOTE), version: versionField.optional() });
const cancelBodySchema = z.strictObject({ reason: z.string().trim().min(1, 'say why').max(MAX_NOTE), version: versionField.optional() });
const payBodySchema = z.strictObject({ paymentDate: accountingDateField, moneyAccountId: recordIdField, amount: minorUnitsField.min(1).optional(), reference: z.string().trim().max(100).optional() });
const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(LOAN_STATUSES).optional(), employeeId: recordIdField.optional() });
const leaveBodySchema = z.strictObject({
  // Half days are allowed.
  days: z.number().min(0).max(MAX_LEAVE_DAYS).refine((days) => Number.isInteger(days * 2), 'must be whole or half days'),
  note: z.string().trim().max(200).optional(),
});

const idOf = (req: Request) => String(req.params.id);
const bodyOf = (req: Request) => req.body ?? {};

const handleList: RequestHandler = async (req, res) => {
  res.json(await listEmployeeLoans(parseRequestQuery(listQuerySchema, req.query)));
};
const handleGet: RequestHandler = async (req, res) => {
  res.json(await getEmployeeLoan(getActor(req), idOf(req)));
};
const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createEmployeeLoan(getActor(req), parseRequestBody(createBodySchema, req.body)));
};
const handleSubmit: RequestHandler = async (req, res) => {
  res.json(await submitEmployeeLoan(getActor(req), idOf(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveEmployeeLoan(getActor(req), idOf(req), parseRequestBody(decisionBodySchema, bodyOf(req)).version));
};
const handleReturn: RequestHandler = async (req, res) => {
  res.json(await returnEmployeeLoan(getActor(req), idOf(req), parseRequestBody(returnBodySchema, req.body)));
};
const handleCancel: RequestHandler = async (req, res) => {
  res.json(await cancelEmployeeLoan(getActor(req), idOf(req), parseRequestBody(cancelBodySchema, req.body)));
};
const handlePay: RequestHandler = async (req, res) => {
  res.status(201).json(await payEmployeeLoan(getActor(req), idOf(req), parseRequestBody(payBodySchema, req.body)));
};
const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getEmployeeLoanHistory(idOf(req), parseRequestQuery(z.object(paginationQueryFields), req.query)));
};
const handleLeave: RequestHandler = async (req, res) => {
  res.json(await listUnpaidLeave(parseRequestQuery(z.object({ month: monthField }), req.query).month));
};
const handleSetLeave: RequestHandler = async (req, res) => {
  const month = parseRequestQuery(z.object({ month: monthField }), { month: req.params.month }).month;
  res.json(await setUnpaidLeave(getActor(req), String(req.params.employeeId), month, parseRequestBody(leaveBodySchema, req.body)));
};

const BASE = '/accounts/employee-loans';

/**
 * Loans and advances to employees, repaid through payroll, and the unpaid leave payroll deducts. Approve, return and
 * cancel are decided in the service, never by the maker. Leave is kept here until HR is built.
 */
export const employeeLoanRoutes: ApiRoute[] = [
  { method: 'GET', path: BASE, access: 'private', permission: 'employeeLoan.read', handler: handleList },
  { method: 'POST', path: BASE, access: 'private', permission: 'employeeLoan.create', bodySchema: createBodySchema, handler: handleCreate },
  { method: 'GET', path: `${BASE}/:id`, access: 'private', permission: 'employeeLoan.read', handler: handleGet },
  { method: 'POST', path: `${BASE}/:id/submit`, access: 'private', permission: 'employeeLoan.update', bodySchema: decisionBodySchema, handler: handleSubmit },
  { method: 'POST', path: `${BASE}/:id/approve`, access: 'private', permission: 'employeeLoan.read', bodySchema: decisionBodySchema, handler: handleApprove },
  { method: 'POST', path: `${BASE}/:id/return`, access: 'private', permission: 'employeeLoan.read', bodySchema: returnBodySchema, handler: handleReturn },
  { method: 'POST', path: `${BASE}/:id/cancel`, access: 'private', permission: 'employeeLoan.read', bodySchema: cancelBodySchema, handler: handleCancel },
  { method: 'POST', path: `${BASE}/:id/pay`, access: 'private', permission: 'journalVoucher.create', bodySchema: payBodySchema, handler: handlePay },
  { method: 'GET', path: `${BASE}/:id/history`, access: 'private', permission: 'employeeLoan.read', handler: handleHistory },
  { method: 'GET', path: '/accounts/unpaid-leave', access: 'private', permission: 'unpaidLeave.read', handler: handleLeave },
  { method: 'PUT', path: '/accounts/unpaid-leave/:employeeId/:month', access: 'private', permission: 'unpaidLeave.update', bodySchema: leaveBodySchema, handler: handleSetLeave },
];

export const employeeLoanApprovals: ApprovalSource = {
  type: 'employeeLoan',
  readPermission: 'employeeLoan.read',
  approvePermission: 'employeeLoan.approve',
  async findWaiting(creator, limit) {
    const { loans, total } = await findSubmittedEmployeeLoans(creator, limit);
    return { total, records: loans.map((loan) => ({ id: loan._id, number: loan.number, title: `${loan.kind === 'loan' ? 'Loan' : 'Advance'} to ${loan.employeeName}`, amount: loan.amount, date: loan.issueDate, createdBy: loan.createdBy, submittedAt: loan.submittedAt })) };
  },
};
