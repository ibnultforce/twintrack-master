import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { markTasksInvoiced, releaseInvoicedTasks } from '../../projects/billing/taskBilling.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { findClientBilling } from '../clientAccount/clientAccount.service.js';
import { rateOn, toPaisa } from '../currency/exchangeRates.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { addDays, assertWithinOpenAmount, paymentStateOf, wrongDocumentStatus, type PaymentStatus } from '../documents/documentState.js';
import { findVouchersLinkedTo, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { postEntry, reverseEntry, type NewLedgerLine } from '../ledger/ledger.service.js';
import { Invoice, type InvoiceDoc, type InvoiceLine, type InvoiceStatus } from '../models/invoice.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { findUnbilledTasks, linesForItems, linesForTasks, type ManualInvoiceItem } from './invoiceLines.js';

const INVOICE_RESOURCE = 'invoice';
const APPROVE_PERMISSION = 'invoice.approve';

export interface InvoiceDetails {
  clientId: string;
  issueDate: string;
  /** Defaults to the issue date plus the client's terms. */
  dueDate?: string;
  /** Defaults to the client's billing currency. */
  currency?: string;
  /** Finished, billable tasks to bill at the client's hourly rate. */
  taskIds?: string[];
  /** Lines typed by hand, such as a milestone. */
  items?: ManualInvoiceItem[];
}

export interface InvoiceListFilter {
  status?: InvoiceStatus;
  paymentStatus?: PaymentStatus;
  clientId?: string;
  from?: string;
  to?: string;
  /** The start of an invoice number, or any part of the client's name. */
  search?: string;
}

const STATUS_LABELS: Record<InvoiceStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', issued: 'issued', cancelled: 'cancelled' };

export const invoiceNotFound = () => new ApiError(404, 'unknown_invoice', 'No such invoice.');

const historyRef = (invoiceId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: INVOICE_RESOURCE, recordId: invoiceId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, INVOICE_RESOURCE);

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some invoice details are invalid.', [{ path, message }]);

function assertStatus(invoice: InvoiceDoc, allowed: InvoiceStatus, action: string): void {
  if (invoice.status !== allowed) throw wrongDocumentStatus('invoice', STATUS_LABELS[invoice.status], allowed, action);
}

async function requireInvoice(invoiceId: string): Promise<InvoiceDoc> {
  const invoice = await Invoice.findById(invoiceId).lean();
  if (!invoice) throw invoiceNotFound();
  return invoice;
}

const totalOf = (lines: InvoiceLine[]) => lines.reduce((sum, line) => sum + line.amount, 0);

const taskIdsOf = (lines: InvoiceLine[]) => lines.flatMap((line) => (line.taskId ? [line.taskId] : []));

async function peopleNamed(invoices: InvoiceDoc[]): Promise<Map<string, string>> {
  const ids = new Set(invoices.flatMap((invoice) => [invoice.createdBy, invoice.submittedBy, invoice.approvedBy, invoice.cancelledBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

async function viewsOf(invoices: InvoiceDoc[], rules: FieldRules) {
  const [names, settled] = await Promise.all([peopleNamed(invoices), sumSettledAmounts(invoices.map((invoice) => invoice._id))]);
  return invoices.map((invoice) => redactRecord({
    id: invoice._id,
    number: invoice.number,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    currency: invoice.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lines: invoice.lines,
    total: invoice.total,
    exchangeRate: invoice.exchangeRate,
    totalInTaka: invoice.totalInTaka,
    status: invoice.status,
    // Only an issued invoice is owed; drafts and cancelled ones have nothing to receive.
    ...(invoice.status === 'issued' && paymentStateOf(invoice.total, invoice.dueDate, settled.get(invoice._id))),
    returnNote: invoice.returnNote,
    createdBy: personRef(invoice.createdBy, names),
    createdAt: invoice.createdAt,
    submittedBy: personRef(invoice.submittedBy, names),
    submittedAt: invoice.submittedAt,
    approvedBy: personRef(invoice.approvedBy, names),
    approvedAt: invoice.approvedAt,
    ledgerEntryId: invoice.ledgerEntryId,
    cancelledBy: personRef(invoice.cancelledBy, names),
    cancelledAt: invoice.cancelledAt,
    reversalEntryId: invoice.reversalEntryId,
    version: invoice.version,
    updatedAt: invoice.updatedAt,
  }, rules));
}

async function viewFor(actor: Actor, invoice: InvoiceDoc) {
  const [view] = await viewsOf([invoice], await fieldRulesFor(actor));
  if (!view) throw new Error('Viewing an invoice returned nothing.');
  return view;
}

const auditFields = (actor: Actor, invoice: InvoiceDoc) => ({
  ...actorFields(actor),
  targetType: INVOICE_RESOURCE,
  targetId: invoice._id,
  targetName: `${invoice.number} ${invoice.clientName}`,
  module: ACCOUNTS_MODULE_KEY,
});

/** Saves one change with its history and activity log entry, in one transaction with any ledger or task work it does first. */
async function changeInvoice(
  actor: Actor,
  existing: InvoiceDoc,
  auditAction: string,
  buildUpdate: (session: ClientSession) => Promise<UpdateQuery<InvoiceDoc>>,
  options: { version?: number; reason?: string } = {},
): Promise<InvoiceDoc> {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeRecord(Invoice, existing._id, update, { actorId: actor.user._id, expectedVersion: options.version ?? existing.version, session }, invoiceNotFound);
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason: options.reason }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

/** What the client's finished, billable tasks in a period would bill, for choosing what goes on an invoice. */
export async function listBillableTasks(clientId: string, from: string, to: string) {
  const billing = await findClientBilling(clientId);
  return { client: billing, tasks: await findUnbilledTasks(billing, from, to) };
}

export async function listInvoices(actor: Actor, { status, paymentStatus, clientId, from, to, search, ...page }: PageRequest & InvoiceListFilter) {
  const dateRange = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const filter = {
    // Payment status applies to issued invoices only, and is worked out, so it narrows the list after reading.
    ...(paymentStatus ? { status: 'issued' as const } : status && { status }),
    ...(clientId && { clientId }),
    ...(Object.keys(dateRange).length > 0 && { issueDate: dateRange }),
    ...(search && { $or: [{ number: { $regex: `^${escapeRegex(search)}`, $options: 'i' } }, { clientName: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
  const rules = await fieldRulesFor(actor);
  if (paymentStatus) {
    const all = await viewsOf(await Invoice.find(filter).sort({ issueDate: -1, number: -1 }).lean(), rules);
    const matching = all.filter((invoice) => invoice.paymentStatus === paymentStatus);
    return { total: matching.length, page: page.page, pageSize: page.pageSize, invoices: matching.slice(pageOffset(page), pageOffset(page) + page.pageSize) };
  }
  const [invoices, total] = await Promise.all([
    Invoice.find(filter).sort({ issueDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Invoice.countDocuments(filter),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, invoices: await viewsOf(invoices, rules) };
}

/** One invoice, with its receipts and what the caller may do next, so a screen shows only buttons that will work. */
export async function getInvoice(actor: Actor, invoiceId: string) {
  const invoice = await requireInvoice(invoiceId);
  const [view, canDecide, receipts] = await Promise.all([viewFor(actor, invoice), mayDecide(actor, invoice, APPROVE_PERMISSION), findVouchersLinkedTo(invoice._id)]);
  const canUpdate = Boolean(actor.permissions['invoice.update']);
  const hasReceipts = receipts.some((voucher) => voucher.status !== 'reversed');
  const isOwed = invoice.status === 'issued' && 'outstanding' in view && Number(view.outstanding) - Number(view.pending ?? 0) > 0;
  return {
    ...view,
    receipts: receipts.map((voucher) => ({ id: voucher._id, number: voucher.number, voucherDate: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0, status: voucher.status })),
    allowedActions: {
      edit: canUpdate && invoice.status === 'draft',
      submit: canUpdate && invoice.status === 'draft',
      approve: canDecide && invoice.status === 'submitted',
      return: canDecide && invoice.status === 'submitted',
      cancel: (invoice.status === 'draft' && canUpdate) || (invoice.status === 'issued' && canDecide && !hasReceipts),
      receivePayment: Boolean(actor.permissions['journalVoucher.create']) && isOwed,
    },
  };
}

/** Lines from tasks and typed items; an invoice needs at least one, and a total above zero. */
async function buildLines(billing: Awaited<ReturnType<typeof findClientBilling>>, currency: string, taskIds: string[], items: ManualInvoiceItem[], invoiceId?: string) {
  const fromTasks = await linesForTasks(billing, currency, taskIds, invoiceId);
  const lines = [...fromTasks.lines, ...linesForItems(items)];
  if (lines.length === 0) throw invalid('items', 'add at least one task or item');
  const total = totalOf(lines);
  if (total <= 0) throw invalid('items', 'the invoice must be above zero');
  return { lines, total };
}

/** Saves a draft. Its tasks are marked invoiced at once, so two invoices can never bill the same task. */
export async function createInvoice(actor: Actor, details: InvoiceDetails) {
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(details), 'create');
  const billing = await findClientBilling(details.clientId);
  const currency = details.currency ?? billing.currency;
  // Checked now, so an invoice in a currency with no rate is refused before anyone approves it.
  await rateOn(currency, details.issueDate, 'currency');
  const dueDate = details.dueDate ?? addDays(details.issueDate, billing.termsDays);
  if (dueDate < details.issueDate) throw invalid('dueDate', 'must be on or after the issue date');
  const { lines, total } = await buildLines(billing, currency, details.taskIds ?? [], details.items ?? []);
  const number = await takeNextDocumentNumber('invoice', 'INV-');

  const invoice = await runInTransaction(async (session) => {
    const [created] = await Invoice.create([{
      _id: `in_${randomUUID()}`,
      number,
      clientId: billing.clientId,
      clientName: billing.clientName,
      currency,
      issueDate: details.issueDate,
      dueDate,
      lines,
      total,
      status: 'draft',
      createdBy: actor.user._id,
      updatedBy: actor.user._id,
    }], { session });
    if (!created) throw new Error('Creating the invoice returned nothing.');
    const saved = created.toObject();
    await markTasksInvoiced(taskIdsOf(lines), saved._id, session);
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'invoice.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return viewFor(actor, invoice);
}

/**
 * Edits a draft, with a reason kept in its history. `taskIds` and `items` each replace the whole set: tasks taken off
 * are free to bill again, and tasks added are marked invoiced, in the same transaction.
 */
export async function updateInvoice(actor: Actor, invoiceId: string, request: Partial<Omit<InvoiceDetails, 'clientId'>> & { reason: string; version?: number }) {
  const { version, reason, ...changes } = request;
  const existing = await requireInvoice(invoiceId);
  assertStatus(existing, 'draft', 'edited');
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(changes), 'update');

  const currency = changes.currency ?? existing.currency;
  const issueDate = changes.issueDate ?? existing.issueDate;
  if (changes.currency || changes.issueDate) await rateOn(currency, issueDate, 'currency');
  const dueDate = changes.dueDate ?? existing.dueDate;
  if (dueDate < issueDate) throw invalid('dueDate', 'must be on or after the issue date');

  const linesChange = changes.taskIds || changes.items || changes.currency;
  const rebuilt = linesChange
    ? await buildLines(
      await findClientBilling(existing.clientId),
      currency,
      changes.taskIds ?? taskIdsOf(existing.lines),
      changes.items ?? existing.lines.filter((line) => !line.taskId).map((line) => ({ description: line.description, amount: line.amount, ...(line.milestone && { milestone: line.milestone }) })),
      existing._id,
    )
    : undefined;

  const saved = await changeInvoice(actor, existing, 'invoice.updated', async (session) => {
    if (rebuilt) {
      await releaseInvoicedTasks(existing._id, session);
      await markTasksInvoiced(taskIdsOf(rebuilt.lines), existing._id, session);
    }
    return { $set: { currency, issueDate, dueDate, ...rebuilt } };
  }, { version, reason });
  return viewFor(actor, saved);
}

export async function submitInvoice(actor: Actor, invoiceId: string, version?: number) {
  const existing = await requireInvoice(invoiceId);
  assertStatus(existing, 'draft', 'submitted');
  await rateOn(existing.currency, existing.issueDate, 'currency');
  const saved = await changeInvoice(actor, existing, 'invoice.submitted', async () => ({
    $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() },
    $unset: { returnNote: 1 },
  }), { version });
  return viewFor(actor, saved);
}

/**
 * Approves a submitted invoice and records what the client owes, in taka at the rate on its issue date: receivable
 * against service income, in one transaction with the approval.
 */
export async function approveInvoice(actor: Actor, invoiceId: string, version?: number) {
  const existing = await requireInvoice(invoiceId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const exchangeRate = await rateOn(existing.currency, existing.issueDate, 'currency');
  const totalInTaka = toPaisa(existing.total, exchangeRate);

  const saved = await changeInvoice(actor, existing, 'invoice.approved', async (session) => {
    const entry = await postEntry(actor, {
      entryDate: existing.issueDate,
      memo: `${existing.number} ${existing.clientName}`,
      source: { type: INVOICE_RESOURCE, id: existing._id },
      lines: [
        { accountId: POSTING_ACCOUNTS.receivable, debit: totalInTaka, memo: existing.clientName },
        { accountId: POSTING_ACCOUNTS.serviceIncome, credit: totalInTaka, memo: existing.number },
      ],
    }, session);
    return { $set: { status: 'issued', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id, exchangeRate, totalInTaka } };
  }, { version });
  return viewFor(actor, saved);
}

export async function returnInvoice(actor: Actor, invoiceId: string, request: { note: string; version?: number }) {
  const existing = await requireInvoice(invoiceId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changeInvoice(actor, existing, 'invoice.returned', async () => ({
    $set: { status: 'draft', returnNote: request.note },
    $unset: { submittedBy: 1, submittedAt: 1 },
  }), { version: request.version });
  return viewFor(actor, saved);
}

/**
 * Gives up a draft, or cancels an issued invoice with a reversal dated today. Either way its tasks are free to bill
 * again. An issued invoice with receipts, even ones waiting for approval, is refused: reverse them first.
 */
export async function cancelInvoice(actor: Actor, invoiceId: string, request: { reason: string; version?: number }) {
  const existing = await requireInvoice(invoiceId);
  if (existing.status !== 'draft' && existing.status !== 'issued') throw wrongDocumentStatus('invoice', STATUS_LABELS[existing.status], 'draft', 'cancelled');
  const cancelled = { status: 'cancelled', cancelledBy: actor.user._id, cancelledAt: new Date() };
  if (existing.status === 'draft') {
    if (!actor.permissions['invoice.update']) throw new ApiError(403, 'forbidden', "Your profile doesn't let you change invoices.");
    const saved = await changeInvoice(actor, existing, 'invoice.cancelled', async (session) => {
      await releaseInvoicedTasks(existing._id, session);
      return { $set: cancelled };
    }, { version: request.version, reason: request.reason });
    return viewFor(actor, saved);
  }
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const settled = (await sumSettledAmounts([existing._id])).get(existing._id);
  if ((settled?.committed ?? 0) > 0) throw new ApiError(409, 'invoice_has_receipts', `${existing.number} has receipts. Reverse them before cancelling it.`);
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Issued invoice ${existing._id} has no ledger entry.`);
  const saved = await changeInvoice(actor, existing, 'invoice.cancelled', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `Cancels ${existing.number} ${existing.clientName}: ${request.reason}` });
    await releaseInvoicedTasks(existing._id, session);
    return { $set: { ...cancelled, reversalEntryId: reversal._id } };
  }, { version: request.version, reason: request.reason });
  return viewFor(actor, saved);
}

/**
 * Lines for receiving part of an invoice in a foreign currency: the bank gets the amount at the rate on the day it
 * arrived; the receivable is cleared at the rate it was recorded at. The difference is an exchange gain or loss.
 * The receivable side is worked out on the running total, so the last receipt clears exactly what was recorded.
 */
export function receiptLines(
  invoice: Pick<InvoiceDoc, 'number' | 'exchangeRate'>,
  amount: number,
  alreadySettled: number,
  rateOnReceipt: number,
  moneyAccountId: string,
): NewLedgerLine[] {
  const issueRate = invoice.exchangeRate ?? rateOnReceipt;
  const received = toPaisa(amount, rateOnReceipt);
  const cleared = toPaisa(alreadySettled + amount, issueRate) - toPaisa(alreadySettled, issueRate);
  const difference = received - cleared;
  return [
    { accountId: moneyAccountId, debit: received, memo: 'Received' },
    { accountId: POSTING_ACCOUNTS.receivable, credit: cleared, memo: invoice.number },
    ...(difference > 0 ? [{ accountId: POSTING_ACCOUNTS.exchangeGain, credit: difference, memo: `Exchange gain on ${invoice.number}` }] : []),
    ...(difference < 0 ? [{ accountId: POSTING_ACCOUNTS.exchangeLoss, debit: -difference, memo: `Exchange loss on ${invoice.number}` }] : []),
  ];
}

/**
 * Makes a draft receipt voucher for an issued invoice. `amount` is in the invoice's currency and defaults to all
 * that is open. It reaches the books when someone other than its maker approves it, like any voucher.
 */
export async function receiveInvoicePayment(actor: Actor, invoiceId: string, request: { receivedDate: string; moneyAccountId: string; amount?: number; reference?: string }) {
  const invoice = await requireInvoice(invoiceId);
  assertStatus(invoice, 'issued', 'paid');
  const settled = (await sumSettledAmounts([invoice._id])).get(invoice._id);
  const committed = settled?.committed ?? 0;
  const amount = request.amount ?? invoice.total - committed;
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `Nothing is open on ${invoice.number}: it is paid, or receipts for the rest are waiting for approval.`);
  assertWithinOpenAmount(amount, invoice.total, settled, invoice.number);
  const rateOnReceipt = await rateOn(invoice.currency, request.receivedDate, 'receivedDate');

  return createLinkedVoucher(actor, 'receipt', {
    voucherDate: request.receivedDate,
    memo: `Payment for ${invoice.number}`,
    party: invoice.clientName,
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: receiptLines(invoice, amount, committed, rateOnReceipt, request.moneyAccountId),
    linkedDocument: { type: 'invoice', id: invoice._id, number: invoice.number, amount, amountDue: invoice.total },
  });
}

export async function getInvoiceHistory(actor: Actor, invoiceId: string, page: PageRequest) {
  await requireInvoice(invoiceId);
  const history = await listRecordHistory(historyRef(invoiceId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

/** Submitted invoices, oldest submission first, for the Approvals queue. */
export async function findSubmittedInvoices(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [invoices, total] = await Promise.all([Invoice.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(), Invoice.countDocuments(filter)]);
  return { invoices, total };
}
