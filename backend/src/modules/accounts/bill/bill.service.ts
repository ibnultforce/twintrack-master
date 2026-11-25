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
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { assertWithinOpenAmount, paymentStateOf, wrongDocumentStatus, type PaymentStatus } from '../documents/documentState.js';
import { findVouchersLinkedTo, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { checkBalancedLines, postEntry, reverseEntry, type NewLedgerLine } from '../ledger/ledger.service.js';
import { Bill, type BillDoc, type BillLine, type BillStatus, type RegularExpenseLink } from '../models/bill.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { findOrCreateSettings } from '../settings/settings.repository.js';
import { findVendorById, vendorNotFound } from '../vendor/vendor.service.js';

const BILL_RESOURCE = 'bill';
const APPROVE_PERMISSION = 'bill.approve';
const BASIS_POINTS_PER_WHOLE = 10_000;

/** The unique key a live bill made from a regular expense holds, so a period never gets two bills. */
export const regularExpenseKeyOf = (origin: RegularExpenseLink) => `${origin.id}:${origin.period}`;

/** One line as a person writes it; its amount is worked out. */
export interface NewBillLine {
  description: string;
  accountId: string;
  quantity: number;
  /** Paisa. */
  unitPrice: number;
}

export interface BillDetails {
  vendorId: string;
  vendorReference?: string;
  billDate: string;
  /** Defaults to the bill date: due at once. */
  dueDate?: string;
  lines: NewBillLine[];
  /** A Settings tax rate's code, charged as VAT on the amount before tax. */
  vatCode?: string;
}

export interface BillListFilter {
  status?: BillStatus;
  paymentStatus?: PaymentStatus;
  vendorId?: string;
  from?: string;
  to?: string;
  /** The start of a bill number, or any part of the vendor's name or reference. */
  search?: string;
}

const STATUS_LABELS: Record<BillStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', cancelled: 'cancelled' };

export const billNotFound = () => new ApiError(404, 'unknown_bill', 'No such bill.');

const historyRef = (billId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: BILL_RESOURCE, recordId: billId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, BILL_RESOURCE);

function assertStatus(bill: BillDoc, allowed: BillStatus, action: string): void {
  if (bill.status !== allowed) throw wrongDocumentStatus('bill', STATUS_LABELS[bill.status], allowed, action);
}

async function requireBill(billId: string): Promise<BillDoc> {
  const bill = await Bill.findById(billId).lean();
  if (!bill) throw billNotFound();
  return bill;
}

/**
 * Each line's amount is quantity × unit price, rounded to the paisa. VAT and TDS are each a rate on the amount before
 * tax, rounded the same way. The vendor is owed the amount plus VAT, less the TDS withheld for the tax authority.
 */
export function priceBill(lines: NewBillLine[], tdsBasisPoints: number, vatBasisPoints = 0): { lines: BillLine[]; amount: number; vat: number; tds: number; netPayable: number } {
  const priced = lines.map((line) => ({ ...line, amount: Math.round(line.quantity * line.unitPrice) }));
  const amount = priced.reduce((sum, line) => sum + line.amount, 0);
  const vat = Math.round((amount * vatBasisPoints) / BASIS_POINTS_PER_WHOLE);
  const tds = Math.round((amount * tdsBasisPoints) / BASIS_POINTS_PER_WHOLE);
  return { lines: priced, amount, vat, tds, netPayable: amount + vat - tds };
}

/**
 * What recording the bill writes: each line charged to its account, VAT to claim back, the vendor owed the net, and
 * the TDS owed to the tax authority.
 */
function ledgerLinesFor(bill: Pick<BillDoc, 'lines' | 'vat' | 'netPayable' | 'tds' | 'vendorName' | 'number'>): NewLedgerLine[] {
  const vat = bill.vat ?? 0;
  return [
    ...bill.lines.map((line) => ({ accountId: line.accountId, debit: line.amount, memo: line.description })),
    ...(vat > 0 ? [{ accountId: POSTING_ACCOUNTS.vatReceivable, debit: vat, memo: `VAT on ${bill.number}` }] : []),
    { accountId: POSTING_ACCOUNTS.payable, credit: bill.netPayable, memo: `${bill.vendorName}, ${bill.number}` },
    ...(bill.tds > 0 ? [{ accountId: POSTING_ACCOUNTS.taxPayable, credit: bill.tds, memo: `TDS on ${bill.number}` }] : []),
  ];
}

/** The VAT rate a Settings tax rate code names, in basis points; refused when Settings has no such rate. */
async function vatRateFor(vatCode: string | undefined): Promise<number> {
  if (!vatCode) return 0;
  const rate = (await findOrCreateSettings()).taxRates.find((candidate) => candidate.code === vatCode);
  if (!rate) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'vatCode', message: 'is not one of the tax rates in Settings' }]);
  return rate.basisPoints;
}

/** Prices the lines for a vendor and checks them as the ledger will, so a bill that could never be recorded is refused when saved. */
async function priceForVendor(vendorId: string, lines: NewBillLine[], vatCode: string | undefined) {
  const vendor = await findVendorById(vendorId);
  if (!vendor) throw vendorNotFound();
  if (!vendor.isActive) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'vendorId', message: `${vendor.name} is inactive` }]);
  const vatBasisPoints = await vatRateFor(vatCode);
  const priced = { ...priceBill(lines, vendor.tdsBasisPoints, vatBasisPoints), vatCode, vatBasisPoints };
  if (priced.amount <= 0) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'lines', message: 'the bill must be above zero' }]);
  await checkBalancedLines(ledgerLinesFor({ ...priced, vendorName: vendor.name, number: 'new bill' }));
  return { vendor, ...priced, tdsBasisPoints: vendor.tdsBasisPoints };
}

async function peopleNamed(bills: BillDoc[]): Promise<Map<string, string>> {
  const ids = new Set(bills.flatMap((bill) => [bill.createdBy, bill.submittedBy, bill.approvedBy, bill.cancelledBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

async function viewsOf(bills: BillDoc[], rules: FieldRules) {
  const [names, settled] = await Promise.all([peopleNamed(bills), sumSettledAmounts(bills.map((bill) => bill._id))]);
  return bills.map((bill) => redactRecord({
    id: bill._id,
    number: bill.number,
    vendorId: bill.vendorId,
    vendorName: bill.vendorName,
    vendorReference: bill.vendorReference,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    lines: bill.lines,
    amount: bill.amount,
    vatCode: bill.vatCode,
    vatBasisPoints: bill.vatBasisPoints ?? 0,
    vat: bill.vat ?? 0,
    tdsBasisPoints: bill.tdsBasisPoints,
    tds: bill.tds,
    netPayable: bill.netPayable,
    status: bill.status,
    regularExpense: bill.regularExpense,
    // Only a recorded bill is owed; drafts and cancelled bills have nothing to pay.
    ...(bill.status === 'recorded' && paymentStateOf(bill.netPayable, bill.dueDate, settled.get(bill._id))),
    returnNote: bill.returnNote,
    createdBy: personRef(bill.createdBy, names),
    createdAt: bill.createdAt,
    submittedBy: personRef(bill.submittedBy, names),
    submittedAt: bill.submittedAt,
    approvedBy: personRef(bill.approvedBy, names),
    approvedAt: bill.approvedAt,
    ledgerEntryId: bill.ledgerEntryId,
    cancelledBy: personRef(bill.cancelledBy, names),
    cancelledAt: bill.cancelledAt,
    reversalEntryId: bill.reversalEntryId,
    version: bill.version,
    updatedAt: bill.updatedAt,
  }, rules));
}

async function viewFor(actor: Actor, bill: BillDoc) {
  const [view] = await viewsOf([bill], await fieldRulesFor(actor));
  if (!view) throw new Error('Viewing a bill returned nothing.');
  return view;
}

const auditFields = (actor: Actor, bill: BillDoc) => ({ ...actorFields(actor), targetType: BILL_RESOURCE, targetId: bill._id, targetName: `${bill.number} ${bill.vendorName}`, module: ACCOUNTS_MODULE_KEY });

/** Saves one change with its history and activity log entry, in one transaction with any ledger work it does first. */
async function changeBill(
  actor: Actor,
  existing: BillDoc,
  auditAction: string,
  buildUpdate: (session: ClientSession) => Promise<UpdateQuery<BillDoc>>,
  options: { version?: number; reason?: string } = {},
): Promise<BillDoc> {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeRecord(Bill, existing._id, update, { actorId: actor.user._id, expectedVersion: options.version ?? existing.version, session }, billNotFound);
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason: options.reason }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

export async function listBills(actor: Actor, { status, paymentStatus, vendorId, from, to, search, ...page }: PageRequest & BillListFilter) {
  const dateRange = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const filter = {
    // Payment status applies to recorded bills only, and is worked out, so it narrows the list after reading.
    ...(paymentStatus ? { status: 'recorded' as const } : status && { status }),
    ...(vendorId && { vendorId }),
    ...(Object.keys(dateRange).length > 0 && { billDate: dateRange }),
    ...(search && {
      $or: [
        { number: { $regex: `^${escapeRegex(search)}`, $options: 'i' } },
        { vendorName: { $regex: escapeRegex(search), $options: 'i' } },
        { vendorReference: { $regex: escapeRegex(search), $options: 'i' } },
      ],
    }),
  };
  const rules = await fieldRulesFor(actor);
  if (paymentStatus) {
    const all = await viewsOf(await Bill.find(filter).sort({ billDate: -1, number: -1 }).lean(), rules);
    const matching = all.filter((bill) => bill.paymentStatus === paymentStatus);
    return { total: matching.length, page: page.page, pageSize: page.pageSize, bills: matching.slice(pageOffset(page), pageOffset(page) + page.pageSize) };
  }
  const [bills, total] = await Promise.all([
    Bill.find(filter).sort({ billDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Bill.countDocuments(filter),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, bills: await viewsOf(bills, rules) };
}

/** Bills by id, newest first, as the caller may see them: for screens that pick bills another way, such as Office rent. */
export async function listBillsByIds(actor: Actor, billIds: string[]) {
  const bills = await Bill.find({ _id: { $in: billIds } }).sort({ billDate: -1, number: -1 }).lean();
  return viewsOf(bills, await fieldRulesFor(actor));
}

/** One bill, with its payments and what the caller may do next, so a screen shows only buttons that will work. */
export async function getBill(actor: Actor, billId: string) {
  const bill = await requireBill(billId);
  const [view, canDecide, payments] = await Promise.all([viewFor(actor, bill), mayDecide(actor, bill, APPROVE_PERMISSION), findVouchersLinkedTo(bill._id)]);
  const canUpdate = Boolean(actor.permissions['bill.update']);
  const hasPayments = payments.some((voucher) => voucher.status !== 'reversed');
  const isOwed = bill.status === 'recorded' && 'outstanding' in view && Number(view.outstanding) - Number(view.pending ?? 0) > 0;
  return {
    ...view,
    payments: payments.map((voucher) => ({ id: voucher._id, number: voucher.number, voucherDate: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0, status: voucher.status })),
    allowedActions: {
      edit: canUpdate && bill.status === 'draft',
      submit: canUpdate && bill.status === 'draft',
      approve: canDecide && bill.status === 'submitted',
      return: canDecide && bill.status === 'submitted',
      cancel: (bill.status === 'draft' && canUpdate) || (bill.status === 'recorded' && canDecide && !hasPayments),
      pay: Boolean(actor.permissions['journalVoucher.create']) && isOwed,
    },
  };
}

/**
 * Saves a draft bill. `origin` names the regular expense and period it was made for. People never send it: only the
 * regular expenses feature does, and a period that already has a live bill is refused by the unique key.
 */
export async function createBill(actor: Actor, details: BillDetails, origin?: RegularExpenseLink) {
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(details), 'create');
  const priced = await priceForVendor(details.vendorId, details.lines, details.vatCode);
  const number = await takeNextDocumentNumber('bill', 'B-');
  const bill = await runInTransaction(async (session) => {
    const [created] = await Bill.create([{
      _id: `bl_${randomUUID()}`,
      number,
      vendorId: priced.vendor._id,
      vendorName: priced.vendor.name,
      ...(details.vendorReference && { vendorReference: details.vendorReference }),
      billDate: details.billDate,
      dueDate: details.dueDate ?? details.billDate,
      lines: priced.lines,
      amount: priced.amount,
      ...(priced.vatCode && { vatCode: priced.vatCode, vatBasisPoints: priced.vatBasisPoints, vat: priced.vat }),
      tdsBasisPoints: priced.tdsBasisPoints,
      tds: priced.tds,
      netPayable: priced.netPayable,
      ...(origin && { regularExpense: origin, regularExpenseKey: regularExpenseKeyOf(origin) }),
      status: 'draft',
      createdBy: actor.user._id,
      updatedBy: actor.user._id,
    }], { session });
    if (!created) throw new Error('Creating the bill returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'bill.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return viewFor(actor, bill);
}

/** Edits a draft, with a reason kept in its history. New lines or a new vendor price it again at the vendor's TDS rate. */
export async function updateBill(actor: Actor, billId: string, request: Partial<Omit<BillDetails, 'vatCode'>> & { vatCode?: string | null; reason: string; version?: number }) {
  const { version, reason, ...changes } = request;
  const existing = await requireBill(billId);
  assertStatus(existing, 'draft', 'edited');
  assertMayWriteFields(await fieldRulesFor(actor), Object.keys(changes), 'update');

  // null removes the VAT; leaving it out keeps the bill's rate code.
  const vatCode = changes.vatCode === undefined ? existing.vatCode : (changes.vatCode ?? undefined);
  const repriced = changes.lines || changes.vendorId || changes.vatCode !== undefined
    ? await priceForVendor(changes.vendorId ?? existing.vendorId, changes.lines ?? existing.lines, vatCode)
    : undefined;
  const $set = {
    ...(changes.billDate && { billDate: changes.billDate }),
    ...(changes.dueDate && { dueDate: changes.dueDate }),
    ...(changes.vendorReference && { vendorReference: changes.vendorReference }),
    ...(repriced && {
      vendorId: repriced.vendor._id,
      vendorName: repriced.vendor.name,
      lines: repriced.lines,
      amount: repriced.amount,
      ...(repriced.vatCode && { vatCode: repriced.vatCode, vatBasisPoints: repriced.vatBasisPoints, vat: repriced.vat }),
      tdsBasisPoints: repriced.tdsBasisPoints,
      tds: repriced.tds,
      netPayable: repriced.netPayable,
    }),
  };
  const $unset = {
    ...(changes.vendorReference === '' && { vendorReference: 1 }),
    ...(repriced && !repriced.vatCode && { vatCode: 1, vatBasisPoints: 1, vat: 1 }),
  };
  const saved = await changeBill(actor, existing, 'bill.updated', async () => ({ $set, ...(Object.keys($unset).length > 0 && { $unset }) }), { version, reason });
  return viewFor(actor, saved);
}

export async function submitBill(actor: Actor, billId: string, version?: number) {
  const existing = await requireBill(billId);
  assertStatus(existing, 'draft', 'submitted');
  await checkBalancedLines(ledgerLinesFor(existing));
  const saved = await changeBill(actor, existing, 'bill.submitted', async () => ({
    $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() },
    $unset: { returnNote: 1 },
  }), { version });
  return viewFor(actor, saved);
}

/** Approves a submitted bill and records it in the ledger, in one transaction: both happen, or neither does. */
export async function approveBill(actor: Actor, billId: string, version?: number) {
  const existing = await requireBill(billId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changeBill(actor, existing, 'bill.approved', async (session) => {
    const entry = await postEntry(actor, {
      entryDate: existing.billDate,
      memo: `${existing.number} ${existing.vendorName}`,
      source: { type: BILL_RESOURCE, id: existing._id },
      lines: ledgerLinesFor(existing),
    }, session);
    return { $set: { status: 'recorded', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id } };
  }, { version });
  return viewFor(actor, saved);
}

export async function returnBill(actor: Actor, billId: string, request: { note: string; version?: number }) {
  const existing = await requireBill(billId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changeBill(actor, existing, 'bill.returned', async () => ({
    $set: { status: 'draft', returnNote: request.note },
    $unset: { submittedBy: 1, submittedAt: 1 },
  }), { version: request.version });
  return viewFor(actor, saved);
}

/**
 * Gives up a draft, or cancels a recorded bill with a reversal dated today. A recorded bill with payments, even ones
 * waiting for approval, is refused: reverse the payments first. Cancelling a recorded bill is a decision, so its
 * maker can't do it.
 */
export async function cancelBill(actor: Actor, billId: string, request: { reason: string; version?: number }) {
  const existing = await requireBill(billId);
  if (existing.status !== 'draft' && existing.status !== 'recorded') throw wrongDocumentStatus('bill', STATUS_LABELS[existing.status], 'draft', 'cancelled');
  const cancelled = { status: 'cancelled', cancelledBy: actor.user._id, cancelledAt: new Date() };
  if (existing.status === 'draft') {
    if (!actor.permissions['bill.update']) throw new ApiError(403, 'forbidden', "Your profile doesn't let you change bills.");
    const saved = await changeBill(actor, existing, 'bill.cancelled', async () => ({ $set: cancelled, $unset: { regularExpenseKey: 1 } }), { version: request.version, reason: request.reason });
    return viewFor(actor, saved);
  }
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const settled = (await sumSettledAmounts([existing._id])).get(existing._id);
  if ((settled?.committed ?? 0) > 0) throw new ApiError(409, 'bill_has_payments', `${existing.number} has payments. Reverse them before cancelling it.`);
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded bill ${existing._id} has no ledger entry.`);
  const saved = await changeBill(actor, existing, 'bill.cancelled', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `Cancels ${existing.number} ${existing.vendorName}: ${request.reason}` });
    // Frees the regular expense's period, so it can be billed again.
    return { $set: { ...cancelled, reversalEntryId: reversal._id }, $unset: { regularExpenseKey: 1 } };
  }, { version: request.version, reason: request.reason });
  return viewFor(actor, saved);
}

/**
 * Makes a draft payment voucher for a recorded bill: the vendor's account is cleared from cash or a bank account.
 * It reaches the books when someone other than its maker approves it, like any voucher. Defaults to all that is open.
 */
export async function payBill(actor: Actor, billId: string, request: { paymentDate: string; moneyAccountId: string; amount?: number; reference?: string }) {
  const bill = await requireBill(billId);
  assertStatus(bill, 'recorded', 'paid');
  const settled = (await sumSettledAmounts([bill._id])).get(bill._id);
  const amount = request.amount ?? bill.netPayable - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `Nothing is open on ${bill.number}: it is paid, or payments for the rest are waiting for approval.`);
  assertWithinOpenAmount(amount, bill.netPayable, settled, bill.number);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `Payment of ${bill.number}${bill.vendorReference ? `, ${bill.vendorReference}` : ''}`,
    party: bill.vendorName,
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.payable, debit: amount, memo: bill.number },
      { accountId: request.moneyAccountId, credit: amount, memo: 'Paid out' },
    ],
    linkedDocument: { type: 'bill', id: bill._id, number: bill.number, amount },
  });
}

export async function getBillHistory(actor: Actor, billId: string, page: PageRequest) {
  await requireBill(billId);
  const history = await listRecordHistory(historyRef(billId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

/** Submitted bills, oldest submission first, for the Approvals queue. */
export async function findSubmittedBills(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [bills, total] = await Promise.all([Bill.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(), Bill.countDocuments(filter)]);
  return { bills, total };
}
