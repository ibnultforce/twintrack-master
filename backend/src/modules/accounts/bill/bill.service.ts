import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { changeRecord, moveToRecycleBin } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { findBillableProjects } from '../../tasks/billing/taskBilling.js';
import {
  assertNotOwnRecord,
  fieldRulesFor,
  invalidField,
  MONEY_TOLERANCE,
  readRecordHistory,
  roundMoney,
  writeAccountsRecord,
  writeAccountsRecordIn,
  type Currency,
} from '../accountsModule.js';
import { findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { assertActiveCategory } from '../category/category.service.js';
import { Bill, Payment, type BillDoc, type BillStatus } from '../models/money.js';
import { assertActiveVendor, findVendorNames } from '../vendor/vendor.service.js';

const RESOURCE = 'bill';

export const billNotFound = () => new ApiError(404, 'unknown_bill', 'No such bill.');

const wrongStatus = (message: string) => new ApiError(409, 'invalid_status', message);

export interface BillDetails {
  vendorId: string;
  billNumber?: string;
  categoryId?: string;
  projectId?: string;
  department?: string;
  businessDate: Date;
  dueDate?: Date;
  currency: Currency;
  amount: number;
  taxCode?: string;
  notes?: string;
}

export interface BillListQuery extends PageRequest {
  status?: BillStatus;
  vendorId?: string;
  projectId?: string;
  categoryId?: string;
  /** Approved but not fully paid, and past the due date. */
  overdue?: boolean;
}

/** Statuses a payment can be made against. */
export const PAYABLE_BILL_STATUSES: readonly BillStatus[] = ['approved', 'partially_paid'];

/** What each bill has been paid by payments still in effect, by bill. */
export async function sumBillPayments(billIds: string[], session?: ClientSession): Promise<Map<string, number>> {
  const rows = await Payment.aggregate<{ _id: string; paid: number }>([
    { $match: { billId: { $in: billIds }, reversesId: { $exists: false }, reversalId: { $exists: false }, deletedAt: { $exists: false } } },
    { $group: { _id: '$billId', paid: { $sum: '$amount' } } },
  ]).session(session ?? null);
  return new Map(rows.map((row) => [row._id, roundMoney(row.paid)]));
}

async function assertProjectExists(projectId: string | undefined): Promise<void> {
  if (projectId && (await findBillableProjects([projectId])).length === 0) throw invalidField('projectId', 'no such project');
}

async function assertValidReferences(details: Partial<BillDetails>): Promise<void> {
  if (details.vendorId) await assertActiveVendor(details.vendorId);
  await assertActiveCategory(details.categoryId);
  await assertProjectExists(details.projectId);
  if (details.dueDate && details.businessDate && details.dueDate < details.businessDate) throw invalidField('dueDate', "can't be before businessDate");
}

function toView(bill: BillDoc, rules: FieldRules, paid: number, vendorNames: Map<string, string>) {
  return redactRecord(
    {
      id: bill._id,
      billNumber: bill.billNumber,
      vendorId: bill.vendorId,
      vendorName: vendorNames.get(bill.vendorId),
      categoryId: bill.categoryId,
      projectId: bill.projectId,
      department: bill.department,
      businessDate: bill.businessDate,
      dueDate: bill.dueDate,
      currency: bill.currency,
      amount: bill.amount,
      // Worked out from payments still in effect, never typed in.
      paidAmount: paid,
      outstandingAmount: PAYABLE_BILL_STATUSES.includes(bill.status) || bill.status === 'paid' ? roundMoney(bill.amount - paid) : 0,
      taxCode: bill.taxCode,
      notes: bill.notes,
      status: bill.status,
      decidedBy: bill.decidedBy,
      decidedAt: bill.decidedAt,
      rejectionReason: bill.rejectionReason,
      reversedBy: bill.reversedBy,
      reversedAt: bill.reversedAt,
      reversalReason: bill.reversalReason,
      version: bill.version,
      createdBy: bill.createdBy,
      createdAt: bill.createdAt,
      updatedBy: bill.updatedBy,
      updatedAt: bill.updatedAt,
    },
    rules,
  );
}

async function toViews(actor: Actor, bills: BillDoc[]) {
  const [rules, paid, vendorNames] = await Promise.all([fieldRulesFor(actor, RESOURCE), sumBillPayments(bills.map((bill) => bill._id)), findVendorNames(bills.map((bill) => bill.vendorId))]);
  return bills.map((bill) => toView(bill, rules, paid.get(bill._id) ?? 0, vendorNames));
}

const label = (bill: BillDoc) => bill.billNumber ?? bill._id;

export async function listBills(actor: Actor, query: BillListQuery) {
  const { status, vendorId, projectId, categoryId, overdue, ...page } = query;
  const filter = {
    ...(status && { status }),
    ...(vendorId && { vendorId }),
    ...(projectId && { projectId }),
    ...(categoryId && { categoryId }),
    ...(overdue && { status: { $in: PAYABLE_BILL_STATUSES }, dueDate: { $lt: new Date() } }),
  };
  const { records, total } = await findRecordPage(Bill, filter, page, { businessDate: -1 });
  return { total, bills: await toViews(actor, records) };
}

export async function getBill(actor: Actor, billId: string) {
  const [view] = await toViews(actor, [await requireRecord(Bill, billId, billNotFound)]);
  return view!;
}

export async function createBill(actor: Actor, details: BillDetails) {
  assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys(details), 'create');
  await assertValidReferences(details);
  const created = await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: 'bill.created',
    write: (session) => insertRecord<BillDoc>(Bill, { _id: `bill_${randomUUID()}`, ...details }, actor.user._id, session),
    label,
  });
  return getBill(actor, created._id);
}

/** One change to a bill in a given status, with its history and activity log. */
async function changeBill(
  actor: Actor,
  billId: string,
  change: { auditAction: string; allowedFrom: readonly BillStatus[]; refusal: string; check?: (bill: BillDoc) => void; set: Record<string, unknown>; version?: number },
) {
  const existing = await requireRecord(Bill, billId, billNotFound);
  if (!change.allowedFrom.includes(existing.status)) throw wrongStatus(change.refusal);
  change.check?.(existing);
  await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: change.auditAction,
    before: existing,
    // The status in the filter means a bill that changed status in the meantime is refused, not overwritten.
    write: (session) =>
      changeRecord(Bill, billId, { $set: change.set }, { actorId: actor.user._id, expectedVersion: change.version ?? existing.version, session }, billNotFound),
    label,
  });
  return getBill(actor, billId);
}

/** Only a draft can be edited. Once submitted, the figures are what went for approval. */
export async function updateBill(actor: Actor, billId: string, changes: Partial<BillDetails> & { version?: number }) {
  const { version, ...fields } = changes;
  assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys(fields), 'update');
  const existing = await requireRecord(Bill, billId, billNotFound);
  await assertValidReferences({ ...fields, businessDate: fields.businessDate ?? existing.businessDate, dueDate: fields.dueDate ?? existing.dueDate });
  return changeBill(actor, billId, { auditAction: 'bill.updated', allowedFrom: ['draft'], refusal: 'Only a draft bill can be changed.', set: fields, version });
}

export const submitBill = (actor: Actor, billId: string) =>
  changeBill(actor, billId, { auditAction: 'bill.submitted', allowedFrom: ['draft'], refusal: 'Only a draft bill can be sent for approval.', set: { status: 'pending_approval' } });

export const approveBill = (actor: Actor, billId: string) =>
  changeBill(actor, billId, {
    auditAction: 'bill.approved',
    allowedFrom: ['pending_approval'],
    refusal: 'Only a bill waiting for approval can be approved.',
    check: (bill) => assertNotOwnRecord(actor, bill.createdBy, 'bill'),
    set: { status: 'approved', decidedBy: actor.user._id, decidedAt: new Date() },
  });

export const rejectBill = (actor: Actor, billId: string, reason: string) =>
  changeBill(actor, billId, {
    auditAction: 'bill.rejected',
    allowedFrom: ['pending_approval'],
    refusal: 'Only a bill waiting for approval can be rejected.',
    check: (bill) => assertNotOwnRecord(actor, bill.createdBy, 'bill'),
    set: { status: 'rejected', decidedBy: actor.user._id, decidedAt: new Date(), rejectionReason: reason },
  });

/**
 * Cancels an approved bill that turned out wrong, keeping it on record with the reason. Money already paid against it
 * has to be reversed first, so the bill and the bank account never disagree.
 */
export async function reverseBill(actor: Actor, billId: string, reason: string) {
  const existing = await requireRecord(Bill, billId, billNotFound);
  if (existing.status === 'partially_paid' || existing.status === 'paid') {
    throw new ApiError(409, 'bill_has_payments', 'Reverse the payments made against this bill first.');
  }
  if (existing.status === 'draft') throw wrongStatus('A draft bill can simply be deleted. There is nothing to reverse.');
  return changeBill(actor, billId, {
    auditAction: 'bill.reversed',
    allowedFrom: ['approved'],
    refusal: 'Only an approved bill can be reversed.',
    set: { status: 'reversed', reversedBy: actor.user._id, reversedAt: new Date(), reversalReason: reason },
  });
}

/** A draft was never sent for approval, so it goes to the recycle bin. Posted bills are reversed instead. */
export async function deleteBill(actor: Actor, billId: string): Promise<void> {
  const existing = await requireRecord(Bill, billId, billNotFound);
  if (existing.status !== 'draft') throw wrongStatus('Only a draft bill can be deleted. Reverse a posted one instead.');
  await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: 'bill.deleted',
    before: existing,
    historyAction: 'deleted',
    write: (session) => moveToRecycleBin(Bill, billId, { actorId: actor.user._id, expectedVersion: existing.version, session }, billNotFound),
    label,
  });
}

/**
 * Sets a bill's status from what has been paid against it: approved, partially paid or paid. Runs inside the
 * transaction that posts or reverses a payment, so the two always agree.
 */
export async function settleBillStatus(actor: Actor, billId: string, session: ClientSession): Promise<void> {
  const bill = await Bill.findById(billId).session(session).lean();
  if (!bill || ![...PAYABLE_BILL_STATUSES, 'paid'].includes(bill.status)) return;
  const paid = (await sumBillPayments([billId], session)).get(billId) ?? 0;
  const status: BillStatus = paid <= MONEY_TOLERANCE ? 'approved' : paid >= bill.amount - MONEY_TOLERANCE ? 'paid' : 'partially_paid';
  if (status === bill.status) return;
  await writeAccountsRecordIn(
    actor,
    {
      resource: RESOURCE,
      auditAction: `bill.${status}`,
      before: bill,
      write: (writeSession) => changeRecord(Bill, billId, { $set: { status } }, { actorId: actor.user._id, session: writeSession }, billNotFound),
      label,
    },
    session,
  );
}

export async function getBillHistory(actor: Actor, billId: string, page: PageRequest) {
  await requireRecord(Bill, billId, billNotFound);
  return readRecordHistory(actor, RESOURCE, billId, page);
}
