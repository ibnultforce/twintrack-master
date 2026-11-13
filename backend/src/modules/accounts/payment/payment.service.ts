import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { findBillableProjects } from '../../tasks/billing/taskBilling.js';
import {
  assertPersonExists,
  fieldRulesFor,
  findPeopleNames,
  invalidField,
  MONEY_TOLERANCE,
  roundMoney,
  writeAccountsRecordIn,
  type TransactionMethod,
} from '../accountsModule.js';
import { endOfDay, findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { requireActiveBankAccount } from '../bankAccount/bankAccount.service.js';
import { PAYABLE_BILL_STATUSES, settleBillStatus, sumBillPayments } from '../bill/bill.service.js';
import { assertActiveCategory } from '../category/category.service.js';
import { Bill, Payment, type PayeeType, type PaymentDoc } from '../models/money.js';
import { assertActiveVendor, findVendorNames } from '../vendor/vendor.service.js';

const RESOURCE = 'payment';

export const paymentNotFound = () => new ApiError(404, 'unknown_payment', 'No such payment.');

export interface PaymentDetails {
  bankAccountId: string;
  billId?: string;
  categoryId?: string;
  projectId?: string;
  department?: string;
  payeeType: PayeeType;
  payeeVendorId?: string;
  payeeUserId?: string;
  payeeName?: string;
  amount: number;
  paymentDate: Date;
  method: TransactionMethod;
  reference?: string;
  notes?: string;
}

export interface PaymentListQuery extends PageRequest {
  bankAccountId?: string;
  billId?: string;
  payeeVendorId?: string;
  payeeUserId?: string;
  from?: Date;
  to?: Date;
}

const label = (payment: PaymentDoc) => payment.reference ?? payment._id;

async function toViews(actor: Actor, payments: PaymentDoc[]) {
  const [rules, vendorNames, peopleNames] = await Promise.all([
    fieldRulesFor(actor, RESOURCE),
    findVendorNames(payments.map((payment) => payment.payeeVendorId)),
    findPeopleNames(payments.map((payment) => payment.payeeUserId)),
  ]);
  return payments.map((payment) => toView(payment, rules, vendorNames, peopleNames));
}

function toView(payment: PaymentDoc, rules: FieldRules, vendorNames: Map<string, string>, peopleNames: Map<string, string>) {
  const payee = payment.payeeType === 'vendor' ? vendorNames.get(payment.payeeVendorId ?? '') : payment.payeeType === 'employee' ? peopleNames.get(payment.payeeUserId ?? '') : payment.payeeName;
  return redactRecord(
    {
      id: payment._id,
      bankAccountId: payment.bankAccountId,
      billId: payment.billId,
      categoryId: payment.categoryId,
      projectId: payment.projectId,
      department: payment.department,
      payeeType: payment.payeeType,
      payeeVendorId: payment.payeeVendorId,
      payeeUserId: payment.payeeUserId,
      payeeName: payee,
      amount: payment.amount,
      currency: payment.currency,
      paymentDate: payment.paymentDate,
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      reversesId: payment.reversesId,
      reversalId: payment.reversalId,
      // A reversal, or a payment that has one, no longer counts.
      inEffect: !payment.reversesId && !payment.reversalId,
      version: payment.version,
      createdBy: payment.createdBy,
      createdAt: payment.createdAt,
    },
    rules,
  );
}

/** The payee named by the type, and only that one, checked to exist. */
async function resolvePayee(details: PaymentDetails, billVendorId: string | undefined) {
  if (details.payeeType === 'vendor') {
    const vendorId = details.payeeVendorId ?? billVendorId;
    if (!vendorId) throw invalidField('payeeVendorId', 'is required for a vendor payee');
    if (billVendorId && vendorId !== billVendorId) throw invalidField('payeeVendorId', "must be the bill's vendor");
    await assertActiveVendor(vendorId, 'payeeVendorId');
    return { payeeVendorId: vendorId };
  }
  if (details.payeeType === 'employee') {
    if (!details.payeeUserId) throw invalidField('payeeUserId', 'is required for an employee payee');
    await assertPersonExists('payeeUserId', details.payeeUserId);
    return { payeeUserId: details.payeeUserId };
  }
  if (!details.payeeName) throw invalidField('payeeName', 'is required for another payee');
  return { payeeName: details.payeeName };
}

export async function listPayments(actor: Actor, query: PaymentListQuery) {
  const { bankAccountId, billId, payeeVendorId, payeeUserId, from, to, ...page } = query;
  const filter = {
    ...(bankAccountId && { bankAccountId }),
    ...(billId && { billId }),
    ...(payeeVendorId && { payeeVendorId }),
    ...(payeeUserId && { payeeUserId }),
    ...((from || to) && { paymentDate: { ...(from && { $gte: from }), ...(to && { $lt: endOfDay(to) }) } }),
  };
  const { records, total } = await findRecordPage(Payment, filter, page, { paymentDate: -1 });
  return { total, payments: await toViews(actor, records) };
}

export async function getPayment(actor: Actor, paymentId: string) {
  const [view] = await toViews(actor, [await requireRecord(Payment, paymentId, paymentNotFound)]);
  return view!;
}

/**
 * Checks, inside the payment's transaction, that the bill can take this much. Writing to the bill makes two payments
 * against it at once conflict, so the second retries and rereads what the first paid instead of paying it twice.
 */
async function lockPayableBill(billId: string, currency: string, amount: number, session: ClientSession): Promise<void> {
  const bill = await Bill.findOneAndUpdate({ _id: billId }, { $set: { updatedAt: new Date() } }, { session, returnDocument: 'after', timestamps: false }).lean();
  if (!bill) throw invalidField('billId', 'no such bill');
  if (!PAYABLE_BILL_STATUSES.includes(bill.status)) throw new ApiError(409, 'bill_not_payable', 'Only an approved bill that is not fully paid can be paid.');
  if (bill.currency !== currency) throw invalidField('bankAccountId', `must be in ${bill.currency}, the bill's currency`);
  const outstanding = roundMoney(bill.amount - ((await sumBillPayments([bill._id], session)).get(bill._id) ?? 0));
  if (amount > outstanding + MONEY_TOLERANCE) throw invalidField('amount', `is more than the ${outstanding.toFixed(2)} still owed on this bill`);
}

/**
 * Posts money out of a bank account, in the account's currency. Against a bill, the bill must be approved, in the same
 * currency, and not paid beyond what's owed; the bill's status follows in the same transaction.
 */
export async function createPayment(actor: Actor, details: PaymentDetails) {
  assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys(details), 'create');
  const account = await requireActiveBankAccount(details.bankAccountId);
  await assertActiveCategory(details.categoryId);
  if (details.projectId && (await findBillableProjects([details.projectId])).length === 0) throw invalidField('projectId', 'no such project');

  const bill = details.billId ? await Bill.findById(details.billId).lean() : undefined;
  if (details.billId && !bill) throw invalidField('billId', 'no such bill');
  if (bill && details.payeeType !== 'vendor') throw invalidField('payeeType', 'must be vendor, because a bill is paid to its vendor');
  const payee = await resolvePayee(details, bill?.vendorId);
  // Only the payee the type names is kept.
  const { bankAccountId, billId, categoryId, projectId, department, payeeType, amount, paymentDate, method, reference, notes } = details;
  const rest = { bankAccountId, billId, categoryId, projectId, department, payeeType, amount, paymentDate, method, reference, notes };

  const created = await runInTransaction(async (session) => {
    if (bill) await lockPayableBill(bill._id, account.currency, details.amount, session);
    const payment = await writeAccountsRecordIn(
      actor,
      {
        resource: RESOURCE,
        auditAction: 'payment.created',
        write: (writeSession) =>
          insertRecord<PaymentDoc>(Payment, { _id: `pay_${randomUUID()}`, ...rest, ...payee, currency: account.currency, ...(bill?.categoryId && !rest.categoryId && { categoryId: bill.categoryId }) }, actor.user._id, writeSession),
        label,
      },
      session,
    );
    if (payment.billId) await settleBillStatus(actor, payment.billId, session);
    return payment;
  });
  return getPayment(actor, created._id);
}

/**
 * Cancels a posted payment, such as a transfer the bank returned, with a linked reversal dated today. The original
 * stays on record. Its bill, if any, goes back to owing that amount.
 */
export async function reversePayment(actor: Actor, paymentId: string, reason: string) {
  const original = await requireRecord(Payment, paymentId, paymentNotFound);
  if (original.reversesId) throw new ApiError(409, 'is_reversal', 'A reversal can not itself be reversed. Post a new payment instead.');
  if (original.reversalId) throw new ApiError(409, 'already_reversed', 'This payment has already been reversed.');

  try {
    const reversal = await runInTransaction(async (session) => {
      const { _id, bankAccountId, billId, categoryId, projectId, department, payeeType, payeeVendorId, payeeUserId, payeeName, amount, currency, method, reference } = original;
      const copy = { bankAccountId, billId, categoryId, projectId, department, payeeType, payeeVendorId, payeeUserId, payeeName, amount, currency, method, reference };
      const created = await writeAccountsRecordIn(
        actor,
        {
          resource: RESOURCE,
          auditAction: 'payment.reversed',
          write: (writeSession) =>
            insertRecord<PaymentDoc>(Payment, { ...copy, _id: `pay_${randomUUID()}`, paymentDate: new Date(), reversesId: _id, notes: `Reversal of ${original.reference ?? _id}: ${reason}` }, actor.user._id, writeSession),
          label,
        },
        session,
      );
      await writeAccountsRecordIn(
        actor,
        {
          resource: RESOURCE,
          auditAction: 'payment.marked_reversed',
          before: original,
          write: (writeSession) => changeRecord(Payment, _id, { $set: { reversalId: created._id } }, { actorId: actor.user._id, expectedVersion: original.version, session: writeSession }, paymentNotFound),
          label,
        },
        session,
      );
      if (original.billId) await settleBillStatus(actor, original.billId, session);
      return created;
    });
    return getPayment(actor, reversal._id);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'already_reversed', 'This payment has already been reversed.');
    throw error;
  }
}
