import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { createLinkedJournalVoucher } from '../journalVoucher/journalVoucher.service.js';
import { FixedAsset, type AssetCategory, type FixedAssetDoc } from '../models/fixedAsset.js';
import { JournalVoucher, type JournalVoucherStatus } from '../models/journalVoucher.js';
import { monthLabel } from '../payroll/payroll.service.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { depreciationForMonth, depreciationSchedule } from './depreciation.js';

const ASSET_RESOURCE = 'fixedAsset';

export interface FixedAssetDetails {
  name: string;
  assetTag?: string;
  category: AssetCategory;
  purchaseDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  billId?: string;
}

export const fixedAssetNotFound = () => new ApiError(404, 'unknown_fixed_asset', 'No such fixed asset.');

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const historyRef = (assetId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: ASSET_RESOURCE, recordId: assetId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, ASSET_RESOURCE);

/** The id a month's depreciation run is linked by, so one month can only have one run that isn't reversed. */
const runId = (month: string) => `depreciation-${month}`;

/** Each month's depreciation voucher that isn't reversed: its number and status. */
async function findDepreciationRuns(): Promise<Map<string, { voucherId: string; number: string; status: JournalVoucherStatus }>> {
  const vouchers = await JournalVoucher.find({ 'linkedDocument.type': 'depreciation', status: { $ne: 'reversed' } }).select('number status linkedDocument').lean();
  return new Map(vouchers.map((voucher) => [voucher.linkedDocument?.id.replace('depreciation-', '') ?? '', { voucherId: voucher._id, number: voucher.number, status: voucher.status }]));
}

/**
 * Depreciation recorded so far per asset number, read back from the recorded runs' credit lines to accumulated
 * depreciation, which each name their asset. This is what the books say, never a stored figure.
 */
async function sumRecordedDepreciation(assetNumbers: string[]): Promise<Map<string, number>> {
  const rows = await JournalVoucher.aggregate<{ _id: string; amount: number }>([
    { $match: { 'linkedDocument.type': 'depreciation', status: 'recorded' } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': POSTING_ACCOUNTS.accumulatedDepreciation, 'lines.memo': { $in: assetNumbers } } },
    { $group: { _id: '$lines.memo', amount: { $sum: '$lines.credit' } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.amount]));
}

async function viewsOf(assets: FixedAssetDoc[], rules: FieldRules) {
  const recorded = await sumRecordedDepreciation(assets.map((asset) => asset.number));
  return assets.map((asset) => {
    const accumulated = recorded.get(asset.number) ?? 0;
    return redactRecord({
      id: asset._id,
      number: asset.number,
      name: asset.name,
      assetTag: asset.assetTag,
      category: asset.category,
      purchaseDate: asset.purchaseDate,
      cost: asset.cost,
      salvageValue: asset.salvageValue,
      usefulLifeMonths: asset.usefulLifeMonths,
      monthlyDepreciation: depreciationForMonth(asset, asset.purchaseDate.slice(0, 7)),
      accumulatedDepreciation: accumulated,
      bookValue: asset.cost - accumulated,
      billId: asset.billId,
      isActive: asset.isActive,
      version: asset.version,
      updatedAt: asset.updatedAt,
    }, rules);
  });
}

async function requireAsset(assetId: string): Promise<FixedAssetDoc> {
  const asset = await FixedAsset.findById(assetId).lean();
  if (!asset) throw fixedAssetNotFound();
  return asset;
}

function assertSensibleValues(details: Pick<FixedAssetDetails, 'cost' | 'salvageValue'>): void {
  if (details.salvageValue > details.cost) throw invalid('salvageValue', 'must not be more than the cost');
}

const auditFields = (actor: Actor, asset: FixedAssetDoc) => ({ ...actorFields(actor), targetType: ASSET_RESOURCE, targetId: asset._id, targetName: `${asset.number} ${asset.name}`, module: ACCOUNTS_MODULE_KEY });

export async function listFixedAssets(actor: Actor, { category, isActive, search, ...page }: PageRequest & { category?: AssetCategory; isActive?: boolean; search?: string }) {
  const filter = {
    ...(category && { category }),
    ...(isActive !== undefined && { isActive }),
    ...(search && { $or: [{ number: { $regex: `^${escapeRegex(search)}`, $options: 'i' } }, { name: { $regex: escapeRegex(search), $options: 'i' } }, { assetTag: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
  const [assets, total, rules] = await Promise.all([
    FixedAsset.find(filter).sort({ number: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    FixedAsset.countDocuments(filter),
    fieldRulesFor(actor),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, assets: await viewsOf(assets, rules) };
}

/** One asset with its month-by-month schedule, each month marked recorded, waiting, or not yet run. */
export async function getFixedAsset(actor: Actor, assetId: string) {
  const asset = await requireAsset(assetId);
  const [[view], runs] = await Promise.all([viewsOf([asset], await fieldRulesFor(actor)), findDepreciationRuns()]);
  return {
    ...view,
    schedule: depreciationSchedule(asset).map((row) => {
      const run = runs.get(row.month);
      return { ...row, monthLabel: monthLabel(row.month), ...(run && { voucher: run }) };
    }),
  };
}

export async function createFixedAsset(actor: Actor, details: FixedAssetDetails) {
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');
  assertSensibleValues(details);
  const number = await takeNextDocumentNumber('fixedAsset', 'FA-');
  const asset = await runInTransaction(async (session) => {
    const [created] = await FixedAsset.create([{ _id: `fa_${randomUUID()}`, number, ...details, isActive: true, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the fixed asset returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'fixedAsset.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  const [view] = await viewsOf([asset], rules);
  return view;
}

/** What changes depreciation: refused once any of it is recorded or waiting, so the books and the schedule agree. */
const DEPRECIATION_FIELDS = ['purchaseDate', 'cost', 'salvageValue', 'usefulLifeMonths'] as const;

export async function updateFixedAsset(actor: Actor, assetId: string, request: Partial<FixedAssetDetails> & { isActive?: boolean; version?: number }) {
  const { version, ...changes } = request;
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  const existing = await requireAsset(assetId);
  if (DEPRECIATION_FIELDS.some((field) => changes[field] !== undefined)) {
    const runs = await findDepreciationRuns();
    const touched = depreciationSchedule(existing).some((row) => row.amount > 0 && runs.has(row.month));
    if (touched) throw new ApiError(409, 'asset_depreciated', `${existing.number} already has depreciation in the books, so its cost, dates and life can't change. Reverse those runs first.`);
  }
  assertSensibleValues({ cost: changes.cost ?? existing.cost, salvageValue: changes.salvageValue ?? existing.salvageValue });
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(FixedAsset, assetId, { $set: changes }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session }, fixedAssetNotFound);
    await writeRecordHistory(historyRef(assetId), { action: 'updated', actor, before: existing, after }, session);
    await recordAudit({ action: 'fixedAsset.updated', ...auditFields(actor, after) }, session);
    return after;
  });
  const [view] = await viewsOf([saved], rules);
  return view;
}

export async function getFixedAssetHistory(actor: Actor, assetId: string, page: PageRequest) {
  await requireAsset(assetId);
  const history = await listRecordHistory(historyRef(assetId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

/** What a month's run would record, per active asset still being depreciated, and whether the month already has one. */
export async function previewDepreciation(month: string) {
  const [assets, runs] = await Promise.all([FixedAsset.find({ isActive: true }).sort({ number: 1 }).lean(), findDepreciationRuns()]);
  const lines = assets
    .map((asset) => ({ assetId: asset._id, number: asset.number, name: asset.name, amount: depreciationForMonth(asset, month) }))
    .filter((line) => line.amount > 0);
  return { month, monthLabel: monthLabel(month), lines, total: lines.reduce((sum, line) => sum + line.amount, 0), ...(runs.get(month) && { existingRun: runs.get(month) }) };
}

/**
 * Makes a month's draft depreciation voucher: for each active asset, depreciation expense against accumulated
 * depreciation, the credit line naming the asset. It reaches the books when someone other than its maker approves it.
 * A month with a run that isn't reversed is refused, so no month is depreciated twice.
 */
export async function runDepreciation(actor: Actor, request: { month: string; voucherDate?: string }) {
  if (!actor.permissions['journalVoucher.create']) throw new ApiError(403, 'forbidden', 'A depreciation run makes a journal voucher, so it needs permission to make vouchers.');
  const preview = await previewDepreciation(request.month);
  if (preview.existingRun) throw new ApiError(409, 'depreciation_month_taken', `${preview.monthLabel} already has a depreciation run, ${preview.existingRun.number}. Reverse it to run the month again.`);
  if (preview.lines.length === 0) throw new ApiError(422, 'nothing_to_depreciate', `No active asset has depreciation in ${preview.monthLabel}.`);
  const [year = 0, monthNumber = 0] = request.month.split('-').map(Number);
  const lastDay = `${request.month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
  return createLinkedJournalVoucher(actor, {
    voucherDate: request.voucherDate ?? lastDay,
    memo: `Depreciation, ${preview.monthLabel}`,
    lines: [
      ...preview.lines.map((line) => ({ accountId: POSTING_ACCOUNTS.depreciationExpense, debit: line.amount, memo: `${line.number} ${line.name}` })),
      ...preview.lines.map((line) => ({ accountId: POSTING_ACCOUNTS.accumulatedDepreciation, credit: line.amount, memo: line.number })),
    ],
    linkedDocument: { type: 'depreciation', id: runId(request.month), number: `DEP ${request.month}`, amount: preview.total },
  });
}
