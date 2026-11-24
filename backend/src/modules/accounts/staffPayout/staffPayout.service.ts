import { randomUUID } from 'node:crypto';
import type { ClientSession, UpdateQuery } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { findUnpaidIncentives, markIncentivePaid } from '../../projects/billing/incentivePayouts.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { assertWithinOpenAmount, paymentStateOf, wrongDocumentStatus } from '../documents/documentState.js';
import { findVouchersLinkedTo, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { postEntry, reverseEntry, type NewLedgerLine } from '../ledger/ledger.service.js';
import { AccountsEmployee } from '../models/accountsEmployee.js';
import { StaffPayout, type PayoutKind, type PayoutLine, type PayoutStatus, type StaffPayoutDoc } from '../models/staffPayout.js';
import { monthLabel } from '../payroll/payroll.service.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { findUnpaidCommission } from './commissions.js';

const RESOURCE = 'staffPayout';
const APPROVE_PERMISSION = 'staffPayout.approve';
const PAISA_PER_TAKA = 100;

const STATUS_LABELS: Record<PayoutStatus, string> = { draft: 'a draft', submitted: 'waiting for approval', recorded: 'recorded', cancelled: 'cancelled' };

/** Bonus and incentives go to 5200; commission to 5250. */
const EXPENSE_ACCOUNTS: Record<PayoutKind, string> = { incentive: POSTING_ACCOUNTS.bonusExpense, bonus: POSTING_ACCOUNTS.bonusExpense, commission: POSTING_ACCOUNTS.commissionExpense };

export const staffPayoutNotFound = () => new ApiError(404, 'unknown_staff_payout', 'No such bonus, incentive or commission payout.');

const historyRef = (payoutId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: RESOURCE, recordId: payoutId });

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const [yearOf, monthOf] = [(month: string) => Number(month.slice(0, 4)), (month: string) => Number(month.slice(5, 7))];

/** Project management keeps incentives in taka with decimals; the books keep paisa. */
const takaToPaisa = (taka: number) => Math.round(taka * PAISA_PER_TAKA);

function assertStatus(payout: StaffPayoutDoc, allowed: PayoutStatus, action: string): void {
  if (payout.status !== allowed) throw wrongDocumentStatus('payout', STATUS_LABELS[payout.status], allowed, action);
}

async function requirePayout(payoutId: string): Promise<StaffPayoutDoc> {
  const payout = await StaffPayout.findById(payoutId).lean();
  if (!payout) throw staffPayoutNotFound();
  return payout;
}

/** The expense per person against salaries payable: what recording the payout writes. */
function ledgerLinesFor(payout: Pick<StaffPayoutDoc, 'kind' | 'lines' | 'total' | 'number' | 'title'>): NewLedgerLine[] {
  return [
    ...payout.lines.map((line) => ({ accountId: EXPENSE_ACCOUNTS[payout.kind], debit: line.amount, memo: `${line.name}${line.note ? `, ${line.note}` : ''}` })),
    { accountId: POSTING_ACCOUNTS.salariesPayable, credit: payout.total, memo: `${payout.number} ${payout.title}` },
  ];
}

async function peopleNamed(payouts: StaffPayoutDoc[]): Promise<Map<string, string>> {
  const ids = new Set(payouts.flatMap((payout) => [payout.createdBy, payout.submittedBy, payout.approvedBy, payout.cancelledBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

async function viewsOf(payouts: StaffPayoutDoc[]) {
  const [names, settled] = await Promise.all([peopleNamed(payouts), sumSettledAmounts(payouts.map((payout) => payout._id))]);
  return payouts.map((payout) => ({
    id: payout._id,
    number: payout.number,
    kind: payout.kind,
    title: payout.title,
    month: payout.month,
    payDate: payout.payDate,
    lines: payout.lines,
    total: payout.total,
    headcount: payout.lines.length,
    status: payout.status,
    ...(payout.status === 'recorded' && paymentStateOf(payout.total, payout.payDate, settled.get(payout._id))),
    returnNote: payout.returnNote,
    createdBy: personRef(payout.createdBy, names),
    createdAt: payout.createdAt,
    approvedBy: personRef(payout.approvedBy, names),
    approvedAt: payout.approvedAt,
    cancelledBy: personRef(payout.cancelledBy, names),
    cancelledAt: payout.cancelledAt,
    version: payout.version,
  }));
}

async function viewFor(payout: StaffPayoutDoc) {
  const [view] = await viewsOf([payout]);
  if (!view) throw new Error('Viewing a payout returned nothing.');
  return view;
}

const auditFields = (actor: Actor, payout: StaffPayoutDoc) => ({ ...actorFields(actor), targetType: RESOURCE, targetId: payout._id, targetName: `${payout.number} ${payout.title}`, module: ACCOUNTS_MODULE_KEY });

async function changePayout(actor: Actor, existing: StaffPayoutDoc, auditAction: string, buildUpdate: (session: ClientSession) => Promise<UpdateQuery<StaffPayoutDoc>>, options: { version?: number; reason?: string } = {}) {
  return runInTransaction(async (session) => {
    const update = await buildUpdate(session);
    const saved = await changeRecord(StaffPayout, existing._id, update, { actorId: actor.user._id, expectedVersion: options.version ?? existing.version, session }, staffPayoutNotFound);
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: saved, reason: options.reason }, session);
    await recordAudit({ action: auditAction, ...auditFields(actor, saved) }, session);
    return saved;
  });
}

export async function listStaffPayouts({ kind, status, ...page }: PageRequest & { kind?: PayoutKind; status?: PayoutStatus }) {
  const filter = { ...(kind && { kind }), ...(status && { status }) };
  const [payouts, total] = await Promise.all([
    StaffPayout.find(filter).sort({ payDate: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    StaffPayout.countDocuments(filter),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, payouts: await viewsOf(payouts) };
}

export async function getStaffPayout(actor: Actor, payoutId: string) {
  const payout = await requirePayout(payoutId);
  const [view, canDecide, payments] = await Promise.all([viewFor(payout), mayDecide(actor, payout, APPROVE_PERMISSION), findVouchersLinkedTo(payout._id)]);
  const canUpdate = Boolean(actor.permissions['staffPayout.update']);
  const hasPayments = payments.some((voucher) => voucher.status !== 'reversed');
  const isOwed = payout.status === 'recorded' && 'outstanding' in view && Number(view.outstanding) - Number(view.pending ?? 0) > 0;
  return {
    ...view,
    payments: payments.map((voucher) => ({ id: voucher._id, number: voucher.number, voucherDate: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0, status: voucher.status })),
    allowedActions: {
      submit: canUpdate && payout.status === 'draft',
      approve: canDecide && payout.status === 'submitted',
      return: canDecide && payout.status === 'submitted',
      // A recorded incentive payout has marked the incentives paid in Project management, so it stays.
      cancel: (payout.status === 'draft' && canUpdate) || (payout.status === 'recorded' && payout.kind !== 'incentive' && canDecide && !hasPayments),
      pay: Boolean(actor.permissions['journalVoucher.create']) && isOwed,
    },
  };
}

export type NewStaffPayout =
  | { kind: 'incentive'; month: string; payDate: string }
  | { kind: 'bonus'; title: string; payDate: string; lines: { employeeId: string; amount: number; note?: string }[] }
  | { kind: 'commission'; payDate: string };

/** Incentive people and their months already in a payout that isn't cancelled, so nobody is put on two. */
async function incentivesInPayouts(month: string): Promise<Set<string>> {
  const payouts = await StaffPayout.find({ kind: 'incentive', month, status: { $ne: 'cancelled' } }).select('lines.payeeId').lean();
  return new Set(payouts.flatMap((payout) => payout.lines.map((line) => line.payeeId)));
}

async function linesFor(request: NewStaffPayout): Promise<{ title: string; month?: string; lines: PayoutLine[] }> {
  if (request.kind === 'incentive') {
    const [unpaid, taken] = await Promise.all([findUnpaidIncentives(yearOf(request.month), monthOf(request.month)), incentivesInPayouts(request.month)]);
    const free = unpaid.filter((incentive) => !taken.has(incentive.userId));
    const names = new Map((await findUsersByIds(free.map((incentive) => incentive.userId))).map((person) => [person._id, person.name]));
    return {
      title: `Incentives, ${monthLabel(request.month)}`,
      month: request.month,
      lines: free.map((incentive) => ({
        payeeType: 'user', payeeId: incentive.userId, name: names.get(incentive.userId) ?? incentive.userId,
        amount: takaToPaisa(incentive.totalPayout), note: `${incentive.completedHours} hours at Tk ${incentive.hourlyRate}`,
      })),
    };
  }
  if (request.kind === 'commission') {
    const unpaid = await findUnpaidCommission();
    return { title: `Commission to ${request.payDate}`, lines: unpaid.map((item) => ({ payeeType: 'employee', payeeId: item.employeeId, name: item.name, amount: item.amount, receiptIds: item.receiptIds })) };
  }
  const employees = new Map((await AccountsEmployee.find({ _id: { $in: request.lines.map((line) => line.employeeId) }, isActive: true }).lean()).map((employee) => [employee._id, employee]));
  request.lines.forEach((line, index) => {
    if (!employees.has(line.employeeId)) throw invalid(`lines.${index}.employeeId`, 'no such active employee');
  });
  if (new Set(request.lines.map((line) => line.employeeId)).size !== request.lines.length) throw invalid('lines', 'lists someone twice');
  return {
    title: request.title,
    lines: request.lines.map((line) => ({ payeeType: 'employee', payeeId: line.employeeId, name: employees.get(line.employeeId)?.name ?? line.employeeId, amount: line.amount, ...(line.note && { note: line.note }) })),
  };
}

/** Makes a draft payout: a month's unpaid incentives, everyone's unpaid commission, or a bonus typed per employee. */
export async function createStaffPayout(actor: Actor, request: NewStaffPayout) {
  const { title, month, lines } = await linesFor(request);
  if (lines.length === 0) throw new ApiError(422, 'nothing_to_pay', request.kind === 'incentive' ? `Nobody has an unpaid incentive for ${monthLabel(request.month)}. Generate it in Project management first.` : 'Nobody has anything to pay.');
  const number = await takeNextDocumentNumber('staffPayout', 'BI-');
  const payout = await runInTransaction(async (session) => {
    const [created] = await StaffPayout.create([{
      _id: `sp_${randomUUID()}`, number, kind: request.kind, title, ...(month && { month }), payDate: request.payDate, lines,
      total: lines.reduce((sum, line) => sum + line.amount, 0), status: 'draft', createdBy: actor.user._id, updatedBy: actor.user._id,
    }], { session });
    if (!created) throw new Error('Creating the payout returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'staffPayout.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return viewFor(payout);
}

export async function submitStaffPayout(actor: Actor, payoutId: string, version?: number) {
  const existing = await requirePayout(payoutId);
  assertStatus(existing, 'draft', 'submitted');
  return viewFor(await changePayout(actor, existing, 'staffPayout.submitted', async () => ({ $set: { status: 'submitted', submittedBy: actor.user._id, submittedAt: new Date() }, $unset: { returnNote: 1 } }), { version }));
}

/**
 * Approves and records the payout: expense per person against salaries payable. For incentives, each person's month
 * is marked paid in Project management in the same transaction; if any was paid meanwhile, nothing is recorded.
 */
export async function approveStaffPayout(actor: Actor, payoutId: string, version?: number) {
  const existing = await requirePayout(payoutId);
  assertStatus(existing, 'submitted', 'approved');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  const saved = await changePayout(actor, existing, 'staffPayout.approved', async (session) => {
    if (existing.kind === 'incentive' && existing.month) {
      for (const line of existing.lines) {
        const wasUnpaid = await markIncentivePaid(line.payeeId, yearOf(existing.month), monthOf(existing.month), actor.user._id, session);
        if (!wasUnpaid) throw new ApiError(409, 'incentive_already_paid', `${line.name}'s incentive for ${monthLabel(existing.month)} is already paid. Cancel this payout and make it again.`);
      }
    }
    const entry = await postEntry(actor, { entryDate: existing.payDate, memo: `${existing.number} ${existing.title}`, source: { type: RESOURCE, id: existing._id }, lines: ledgerLinesFor(existing) }, session);
    return { $set: { status: 'recorded', approvedBy: actor.user._id, approvedAt: new Date(), ledgerEntryId: entry._id } };
  }, { version });
  return viewFor(saved);
}

export async function returnStaffPayout(actor: Actor, payoutId: string, request: { note: string; version?: number }) {
  const existing = await requirePayout(payoutId);
  assertStatus(existing, 'submitted', 'returned');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  return viewFor(await changePayout(actor, existing, 'staffPayout.returned', async () => ({ $set: { status: 'draft', returnNote: request.note }, $unset: { submittedBy: 1, submittedAt: 1 } }), { version: request.version }));
}

/**
 * Gives up a draft (its people and receipts can go on another payout), or reverses a recorded bonus or commission
 * payout with no payments. A recorded incentive payout can't be cancelled: Project management has it as paid.
 */
export async function cancelStaffPayout(actor: Actor, payoutId: string, request: { reason: string; version?: number }) {
  const existing = await requirePayout(payoutId);
  const cancelled = { status: 'cancelled', cancelledBy: actor.user._id, cancelledAt: new Date() };
  if (existing.status === 'draft') {
    if (!actor.permissions['staffPayout.update']) throw new ApiError(403, 'forbidden', "Your profile doesn't let you change payouts.");
    return viewFor(await changePayout(actor, existing, 'staffPayout.cancelled', async () => ({ $set: cancelled }), { version: request.version, reason: request.reason }));
  }
  if (existing.status !== 'recorded') throw wrongDocumentStatus('payout', STATUS_LABELS[existing.status], 'draft', 'cancelled');
  if (existing.kind === 'incentive') throw new ApiError(409, 'incentive_payout_recorded', 'A recorded incentive payout is marked paid in Project management, so it can\'t be cancelled.');
  await assertMayDecide(actor, existing, APPROVE_PERMISSION);
  if (((await sumSettledAmounts([existing._id])).get(existing._id)?.committed ?? 0) > 0) throw new ApiError(409, 'payout_has_payments', `${existing.number} has payments. Reverse them first.`);
  const ledgerEntryId = existing.ledgerEntryId;
  if (!ledgerEntryId) throw new Error(`Recorded payout ${existing._id} has no ledger entry.`);
  return viewFor(await changePayout(actor, existing, 'staffPayout.cancelled', async (session) => {
    const reversal = await reverseEntry(actor, ledgerEntryId, session, { memo: `Cancels ${existing.number}: ${request.reason}` });
    return { $set: { ...cancelled, reversalEntryId: reversal._id } };
  }, { version: request.version, reason: request.reason }));
}

/** One draft payment voucher for a recorded payout: salaries payable cleared from a bank account. */
export async function payStaffPayout(actor: Actor, payoutId: string, request: { paymentDate: string; moneyAccountId: string; amount?: number; reference?: string }) {
  const payout = await requirePayout(payoutId);
  assertStatus(payout, 'recorded', 'paid');
  const settled = (await sumSettledAmounts([payout._id])).get(payout._id);
  const amount = request.amount ?? payout.total - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `Nothing is open on ${payout.number}.`);
  assertWithinOpenAmount(amount, payout.total, settled, payout.number);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `${payout.title} (${payout.number})`,
    party: `${payout.lines.length} ${payout.lines.length === 1 ? 'person' : 'people'}`,
    ...(request.reference && { reference: request.reference }),
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.salariesPayable, debit: amount, memo: payout.number },
      { accountId: request.moneyAccountId, credit: amount, memo: 'Paid out' },
    ],
    linkedDocument: { type: 'staffPayout', id: payout._id, number: payout.number, amount },
  });
}

export async function getStaffPayoutHistory(payoutId: string, page: PageRequest) {
  await requirePayout(payoutId);
  return listRecordHistory(historyRef(payoutId), page);
}

export async function findSubmittedStaffPayouts(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'submitted' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [payouts, total] = await Promise.all([StaffPayout.find(filter).sort({ submittedAt: 1, number: 1 }).limit(limit).lean(), StaffPayout.countDocuments(filter)]);
  return { payouts, total };
}
