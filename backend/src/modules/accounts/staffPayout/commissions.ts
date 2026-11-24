import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { findActiveClients, findClientById } from '../../master/clients/clients.repository.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { AccountsEmployee } from '../models/accountsEmployee.js';
import { Invoice } from '../models/invoice.js';
import { JournalVoucher } from '../models/journalVoucher.js';
import { CommissionRule, StaffPayout, type CommissionRuleDoc } from '../models/staffPayout.js';

/*
 * Commission is earned on money received, not on invoices sent: each recorded receipt from a client earns the
 * employee's rate on what reached the bank, in taka. What is earned is worked out, never typed; a commission payout
 * pays chosen receipts, and a receipt is paid once.
 */

const RULE_RESOURCE = 'commissionRule';
const BASIS_POINTS_PER_WHOLE = 10_000;

export const commissionRuleNotFound = () => new ApiError(404, 'unknown_commission_rule', 'No such commission rule.');

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

/** One receipt's commission for one employee. */
export interface CommissionItem {
  receiptId: string;
  receiptNumber: string;
  date: string;
  invoiceNumber?: string;
  /** Paisa that reached the bank. */
  received: number;
  /** Paisa: received × rate, rounded to the paisa. */
  commission: number;
  /** In a payout that isn't cancelled: recorded, or still on its way. */
  payoutNumber?: string;
}

export const commissionOn = (received: number, rateBasisPoints: number) => Math.round((received * rateBasisPoints) / BASIS_POINTS_PER_WHOLE);

/** Receipts already in a commission payout that isn't cancelled, per employee, with the payout's number. */
async function receiptsInPayouts(): Promise<Map<string, string>> {
  const payouts = await StaffPayout.find({ kind: 'commission', status: { $ne: 'cancelled' } }).select('number lines').lean();
  const taken = new Map<string, string>();
  for (const payout of payouts) {
    for (const line of payout.lines) for (const receiptId of line.receiptIds ?? []) taken.set(`${line.payeeId}:${receiptId}`, payout.number);
  }
  return taken;
}

/** Each rule's commission per recorded receipt from its client on or after the rule's start. */
async function earningsFor(rules: CommissionRuleDoc[]) {
  const clientIds = [...new Set(rules.map((rule) => rule.clientId))];
  const invoices = await Invoice.find({ clientId: { $in: clientIds }, status: { $ne: 'draft' } }).select('clientId number').lean();
  const invoiceById = new Map(invoices.map((invoice) => [invoice._id, invoice]));
  const receipts = await JournalVoucher.find({ 'linkedDocument.type': 'invoice', 'linkedDocument.id': { $in: [...invoiceById.keys()] }, status: 'recorded' })
    .sort({ voucherDate: 1, number: 1 })
    .select('number voucherDate moneyAccountId lines linkedDocument')
    .lean();
  const taken = await receiptsInPayouts();
  return rules.map((rule) => {
    const items: CommissionItem[] = receipts
      .filter((receipt) => receipt.voucherDate >= rule.startDate && invoiceById.get(receipt.linkedDocument?.id ?? '')?.clientId === rule.clientId)
      .map((receipt) => {
        // What reached the bank: the receipt's debit to its cash or bank account, in taka.
        const received = receipt.lines.filter((line) => line.accountId === receipt.moneyAccountId).reduce((sum, line) => sum + line.debit, 0);
        const payoutNumber = taken.get(`${rule.employeeId}:${receipt._id}`);
        return {
          receiptId: receipt._id,
          receiptNumber: receipt.number,
          date: receipt.voucherDate,
          invoiceNumber: invoiceById.get(receipt.linkedDocument?.id ?? '')?.number,
          received,
          commission: commissionOn(received, rule.rateBasisPoints),
          ...(payoutNumber && { payoutNumber }),
        };
      });
    return { rule, items };
  });
}

/** Every rule with what it has earned, what is paid or on its way, and what is still to pay. */
export async function listCommissions() {
  const rules = await CommissionRule.find().sort({ createdAt: 1 }).lean();
  const [earnings, employees, clients] = await Promise.all([
    earningsFor(rules.filter((rule) => rule.isActive)),
    AccountsEmployee.find({ _id: { $in: rules.map((rule) => rule.employeeId) } }).select('name employeeCode').lean(),
    findActiveClients(),
  ]);
  const employeeById = new Map(employees.map((employee) => [employee._id, employee]));
  const clientById = new Map(clients.map((client) => [client._id, client.name]));
  const earningsByRule = new Map(earnings.map((earning) => [earning.rule._id, earning.items]));
  return {
    rules: rules.map((rule) => {
      const items = earningsByRule.get(rule._id) ?? [];
      const earned = items.reduce((sum, item) => sum + item.commission, 0);
      const inPayouts = items.filter((item) => item.payoutNumber).reduce((sum, item) => sum + item.commission, 0);
      return {
        id: rule._id,
        employeeId: rule.employeeId,
        employeeName: employeeById.get(rule.employeeId)?.name ?? rule.employeeId,
        clientId: rule.clientId,
        clientName: clientById.get(rule.clientId) ?? rule.clientId,
        rateBasisPoints: rule.rateBasisPoints,
        startDate: rule.startDate,
        isActive: rule.isActive,
        version: rule.version,
        received: items.reduce((sum, item) => sum + item.received, 0),
        earned,
        inPayouts,
        unpaid: earned - inPayouts,
        items,
      };
    }),
  };
}

/** Each employee's commission not yet in a payout, with the receipts it is earned on, for a new commission payout. */
export async function findUnpaidCommission(): Promise<{ employeeId: string; name: string; amount: number; receiptIds: string[] }[]> {
  const { rules } = await listCommissions();
  const byEmployee = new Map<string, { employeeId: string; name: string; amount: number; receiptIds: string[] }>();
  for (const rule of rules.filter((candidate) => candidate.isActive)) {
    for (const item of rule.items.filter((candidate) => !candidate.payoutNumber && candidate.commission > 0)) {
      const current = byEmployee.get(rule.employeeId) ?? { employeeId: rule.employeeId, name: rule.employeeName, amount: 0, receiptIds: [] };
      current.amount += item.commission;
      current.receiptIds.push(item.receiptId);
      byEmployee.set(rule.employeeId, current);
    }
  }
  return [...byEmployee.values()];
}

/** A rule as the API returns it, with `id` like every other record. */
const toRuleView = (rule: CommissionRuleDoc) => ({
  id: rule._id,
  employeeId: rule.employeeId,
  clientId: rule.clientId,
  rateBasisPoints: rule.rateBasisPoints,
  startDate: rule.startDate,
  isActive: rule.isActive,
  version: rule.version,
});

const auditFields = (actor: Actor, rule: CommissionRuleDoc) => ({ ...actorFields(actor), targetType: RULE_RESOURCE, targetId: rule._id, targetName: `${rule.employeeId} on ${rule.clientId}`, module: ACCOUNTS_MODULE_KEY });

/** Adds a rule: an employee earns a rate on what one client pays from a date. One active rule per employee and client. */
export async function createCommissionRule(actor: Actor, details: { employeeId: string; clientId: string; rateBasisPoints: number; startDate: string }) {
  if (!(await AccountsEmployee.exists({ _id: details.employeeId, isActive: true }))) throw invalid('employeeId', 'no such active employee');
  if (!(await findClientById(details.clientId))) throw invalid('clientId', 'no such client');
  if (await CommissionRule.exists({ employeeId: details.employeeId, clientId: details.clientId, isActive: true })) {
    throw new ApiError(409, 'commission_rule_exists', 'This employee already has a rule for this client. Change it instead.');
  }
  const rule = await runInTransaction(async (session) => {
    const [created] = await CommissionRule.create([{ _id: `cr_${randomUUID()}`, ...details, isActive: true, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the commission rule returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory({ module: ACCOUNTS_MODULE_KEY, object: RULE_RESOURCE, recordId: saved._id }, { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'commissionRule.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return toRuleView(rule);
}

/** Changes a rule's rate or start, or stops it. Commission already in a payout keeps the amount it was paid at. */
export async function updateCommissionRule(actor: Actor, ruleId: string, request: { rateBasisPoints?: number; startDate?: string; isActive?: boolean; version?: number }) {
  const { version, ...changes } = request;
  const existing = await CommissionRule.findById(ruleId).lean();
  if (!existing) throw commissionRuleNotFound();
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(CommissionRule, ruleId, { $set: changes }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session }, commissionRuleNotFound);
    await writeRecordHistory({ module: ACCOUNTS_MODULE_KEY, object: RULE_RESOURCE, recordId: ruleId }, { action: 'updated', actor, before: existing, after }, session);
    await recordAudit({ action: 'commissionRule.updated', ...auditFields(actor, after) }, session);
    return after;
  });
  return toRuleView(saved);
}
