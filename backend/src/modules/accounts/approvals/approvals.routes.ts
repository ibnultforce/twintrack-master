import type { RequestHandler } from 'express';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getActor } from '../../master/access/caller.js';
import { billApprovals } from '../bill/bill.routes.js';
import { invoiceApprovals } from '../invoice/invoice.routes.js';
import { journalVoucherApprovals } from '../journalVoucher/journalVoucherApprovals.js';
import { payrollApprovals } from '../payroll/payroll.routes.js';
import { staffPayoutApprovals } from '../staffPayout/staffPayout.routes.js';
import { updateRequestApprovals } from '../updateRequest/updateRequestApprovals.js';
import { listApprovals, type ApprovalSource } from './approvalQueue.service.js';

/** Every Accounts record type that waits for approval. */
const APPROVAL_SOURCES: ApprovalSource[] = [journalVoucherApprovals, invoiceApprovals, billApprovals, payrollApprovals, staffPayoutApprovals, updateRequestApprovals];

const handleList: RequestHandler = async (req, res) => {
  res.json(await listApprovals(getActor(req), APPROVAL_SOURCES));
};

/** Open to anyone who can read at least one kind of approvable record; the service shows only those. */
export const approvalRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/approvals', access: 'private', anyPermission: APPROVAL_SOURCES.map((source) => source.readPermission), handler: handleList },
];
