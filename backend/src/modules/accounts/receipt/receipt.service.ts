import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { findClientById } from '../../master/clients/clients.repository.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { fieldRulesFor, invalidField, MONEY_TOLERANCE, roundMoney, writeAccountsRecord, writeAccountsRecordIn, type TransactionMethod } from '../accountsModule.js';
import { endOfDay, findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { requireActiveBankAccount } from '../bankAccount/bankAccount.service.js';
import { Invoice } from '../models/invoice.js';
import { Receipt, type ReceiptDoc } from '../models/money.js';

const RESOURCE = 'receipt';

export const receiptNotFound = () => new ApiError(404, 'unknown_receipt', 'No such receipt.');

export interface ReceiptDetails {
  bankAccountId: string;
  clientId?: string;
  amount: number;
  bankFee?: number;
  receivedDate: Date;
  method: TransactionMethod;
  reference?: string;
  notes?: string;
}

export interface ReceiptListQuery extends PageRequest {
  bankAccountId?: string;
  clientId?: string;
  from?: Date;
  to?: Date;
}

const label = (receipt: ReceiptDoc) => receipt.reference ?? receipt._id;

/** How much of each invoice receipts have paid, by invoice. Reversed receipts have no allocations, so all count. */
export async function sumInvoiceAllocations(invoiceIds: string[], session?: ClientSession): Promise<Map<string, number>> {
  const rows = await Receipt.aggregate<{ _id: string; paid: number }>([
    { $match: { 'allocations.invoiceId': { $in: invoiceIds }, deletedAt: { $exists: false } } },
    { $unwind: '$allocations' },
    { $match: { 'allocations.invoiceId': { $in: invoiceIds } } },
    { $group: { _id: '$allocations.invoiceId', paid: { $sum: '$allocations.amount' } } },
  ]).session(session ?? null);
  return new Map(rows.map((row) => [row._id, roundMoney(row.paid)]));
}

const allocatedTotal = (receipt: ReceiptDoc) => roundMoney(receipt.allocations.reduce((sum, allocation) => sum + allocation.amount, 0));

async function toView(receipt: ReceiptDoc, rules: FieldRules) {
  const invoices = await Invoice.find({ _id: { $in: receipt.allocations.map((allocation) => allocation.invoiceId) } }).select('invoiceNumber').lean();
  const numbers = new Map(invoices.map((invoice) => [invoice._id, invoice.invoiceNumber]));
  const allocated = allocatedTotal(receipt);
  return redactRecord(
    {
      id: receipt._id,
      bankAccountId: receipt.bankAccountId,
      clientId: receipt.clientId,
      amount: receipt.amount,
      bankFee: receipt.bankFee,
      // What reached the bank.
      netAmount: roundMoney(receipt.amount - receipt.bankFee),
      currency: receipt.currency,
      receivedDate: receipt.receivedDate,
      method: receipt.method,
      reference: receipt.reference,
      notes: receipt.notes,
      allocations: receipt.allocations.map((allocation) => ({
        id: allocation._id,
        invoiceId: allocation.invoiceId,
        invoiceNumber: numbers.get(allocation.invoiceId),
        amount: allocation.amount,
        createdBy: allocation.createdBy,
        createdAt: allocation.createdAt,
      })),
      allocatedAmount: allocated,
      unallocatedAmount: receipt.reversesId || receipt.reversalId ? 0 : roundMoney(receipt.amount - allocated),
      reversesId: receipt.reversesId,
      reversalId: receipt.reversalId,
      inEffect: !receipt.reversesId && !receipt.reversalId,
      version: receipt.version,
      createdBy: receipt.createdBy,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    },
    rules,
  );
}

export async function listReceipts(actor: Actor, query: ReceiptListQuery) {
  const { bankAccountId, clientId, from, to, ...page } = query;
  const filter = {
    ...(bankAccountId && { bankAccountId }),
    ...(clientId && { clientId }),
    ...((from || to) && { receivedDate: { ...(from && { $gte: from }), ...(to && { $lt: endOfDay(to) }) } }),
  };
  const { records, total } = await findRecordPage(Receipt, filter, page, { receivedDate: -1 });
  const rules = await fieldRulesFor(actor, RESOURCE);
  return { total, receipts: await Promise.all(records.map((receipt) => toView(receipt, rules))) };
}

export async function getReceipt(actor: Actor, receiptId: string) {
  return toView(await requireRecord(Receipt, receiptId, receiptNotFound), await fieldRulesFor(actor, RESOURCE));
}

/** Posts money into a bank account, in the account's currency. The bank's fee is kept apart from what the client paid. */
export async function createReceipt(actor: Actor, details: ReceiptDetails) {
  assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys(details), 'create');
  const account = await requireActiveBankAccount(details.bankAccountId);
  if (details.clientId && !(await findClientById(details.clientId))) throw invalidField('clientId', 'no such client');
  const bankFee = details.bankFee ?? 0;
  if (bankFee > details.amount) throw invalidField('bankFee', "can't be more than the amount");
  const created = await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: 'receipt.created',
    write: (session) => insertRecord<ReceiptDoc>(Receipt, { _id: `rec_${randomUUID()}`, ...details, bankFee, currency: account.currency, allocations: [] }, actor.user._id, session),
    label,
  });
  return getReceipt(actor, created._id);
}

/**
 * Counts part of a receipt against an invoice. The invoice must be in the receipt's currency, for its client, and
 * neither the receipt nor the invoice can be counted beyond its amount. Runs in a transaction that rereads both, so
 * two allocations at once can't overspend either.
 */
export async function allocateReceipt(actor: Actor, receiptId: string, request: { invoiceId: string; amount: number; version?: number }) {
  await runInTransaction(async (session) => {
    const receipt = await Receipt.findById(receiptId).session(session).lean();
    if (!receipt) throw receiptNotFound();
    if (receipt.reversesId || receipt.reversalId) throw new ApiError(409, 'receipt_reversed', 'A reversed receipt, or a reversal, can not be allocated.');
    // Writing to the invoice makes two allocations to it at once conflict, so the second retries and rereads what's owed.
    const invoice = await Invoice.findOneAndUpdate({ _id: request.invoiceId }, { $set: { updatedAt: new Date() } }, { session, returnDocument: 'after', timestamps: false }).lean();
    if (!invoice) throw invalidField('invoiceId', 'no such invoice');
    if (invoice.currency !== receipt.currency) throw invalidField('invoiceId', `is in ${invoice.currency}, not the receipt's ${receipt.currency}`);
    if (receipt.clientId && invoice.clientId !== receipt.clientId) throw invalidField('invoiceId', "is for another client than the receipt's");

    const left = roundMoney(receipt.amount - allocatedTotal(receipt));
    if (request.amount > left + MONEY_TOLERANCE) throw invalidField('amount', `is more than the ${left.toFixed(2)} left on this receipt`);
    const outstanding = roundMoney(invoice.amount - ((await sumInvoiceAllocations([invoice._id], session)).get(invoice._id) ?? 0));
    if (request.amount > outstanding + MONEY_TOLERANCE) throw invalidField('amount', `is more than the ${outstanding.toFixed(2)} still owed on this invoice`);

    const allocation = { _id: `al_${randomUUID()}`, invoiceId: invoice._id, amount: request.amount, createdBy: actor.user._id, createdAt: new Date() };
    await writeAccountsRecordIn(
      actor,
      {
        resource: RESOURCE,
        auditAction: 'receipt.allocated',
        before: receipt,
        write: (writeSession) =>
          changeRecord(Receipt, receiptId, { $push: { allocations: allocation } }, { actorId: actor.user._id, expectedVersion: request.version ?? receipt.version, session: writeSession }, receiptNotFound),
        label,
      },
      session,
    );
  });
  return getReceipt(actor, receiptId);
}

export async function removeAllocation(actor: Actor, receiptId: string, allocationId: string) {
  const receipt = await requireRecord(Receipt, receiptId, receiptNotFound);
  if (!receipt.allocations.some((allocation) => allocation._id === allocationId)) throw new ApiError(404, 'unknown_allocation', 'No such allocation on this receipt.');
  await writeAccountsRecord(actor, {
    resource: RESOURCE,
    auditAction: 'receipt.allocation_removed',
    before: receipt,
    write: (session) =>
      changeRecord(Receipt, receiptId, { $pull: { allocations: { _id: allocationId } } }, { actorId: actor.user._id, expectedVersion: receipt.version, session }, receiptNotFound),
    label,
  });
  return getReceipt(actor, receiptId);
}

/**
 * Cancels a posted receipt with a linked reversal dated today, taking back what reached the bank. Its allocations have
 * to be removed first, so no invoice looks paid by money that's going back.
 */
export async function reverseReceipt(actor: Actor, receiptId: string, reason: string) {
  const original = await requireRecord(Receipt, receiptId, receiptNotFound);
  if (original.reversesId) throw new ApiError(409, 'is_reversal', 'A reversal can not itself be reversed. Post a new receipt instead.');
  if (original.reversalId) throw new ApiError(409, 'already_reversed', 'This receipt has already been reversed.');
  if (original.allocations.length > 0) throw new ApiError(409, 'receipt_allocated', "Remove this receipt's invoice allocations before reversing it.");

  try {
    const reversal = await runInTransaction(async (session) => {
      const { _id, bankAccountId, clientId, amount, bankFee, currency, method, reference } = original;
      const copy = { bankAccountId, clientId, amount, bankFee, currency, method, reference };
      const created = await writeAccountsRecordIn(
        actor,
        {
          resource: RESOURCE,
          auditAction: 'receipt.reversed',
          write: (writeSession) =>
            insertRecord<ReceiptDoc>(Receipt, { ...copy, _id: `rec_${randomUUID()}`, receivedDate: new Date(), reversesId: _id, allocations: [], notes: `Reversal of ${original.reference ?? _id}: ${reason}` }, actor.user._id, writeSession),
          label,
        },
        session,
      );
      await writeAccountsRecordIn(
        actor,
        {
          resource: RESOURCE,
          auditAction: 'receipt.marked_reversed',
          before: original,
          write: (writeSession) => changeRecord(Receipt, _id, { $set: { reversalId: created._id } }, { actorId: actor.user._id, expectedVersion: original.version, session: writeSession }, receiptNotFound),
          label,
        },
        session,
      );
      return created;
    });
    return getReceipt(actor, reversal._id);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'already_reversed', 'This receipt has already been reversed.');
    throw error;
  }
}
