import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../../master/access/caller.js';
import { readFieldRules } from '../../master/records/fieldSecurity.service.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { actorFields } from '../../master/access/caller.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { financialYearOf } from '../financialYear.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { toCsv } from './csv.js';
import { EXPORT_DATASETS, type ExportDataset, type ExportPeriod } from './exportDatasets.js';

/** The Export center: which lists and reports a person may download, and each one as a CSV file. */

export interface ExportRequest {
  from?: string;
  to?: string;
  year?: number;
}

const mayExport = (actor: Actor, dataset: ExportDataset) => Boolean(actor.permissions[dataset.permission]);

/** Whether the protected field a dataset is made of is hidden from this person. */
async function isMissingRequiredField(actor: Actor, dataset: ExportDataset): Promise<boolean> {
  if (!dataset.requiresField) return false;
  const rules = await readFieldRules(actor, ACCOUNTS_MODULE_KEY, dataset.resource);
  return rules.hidden.includes(dataset.requiresField);
}

/** The datasets this person may download, in the Export center's order, with what each needs to be chosen. */
export async function listExports(actor: Actor) {
  const allowed = EXPORT_DATASETS.filter((dataset) => mayExport(actor, dataset));
  const missing = await Promise.all(allowed.map((dataset) => isMissingRequiredField(actor, dataset)));
  return {
    datasets: allowed.filter((_dataset, index) => !missing[index]).map(({ key, label, group, period }) => ({ key, label, group, period })),
  };
}

const missingInput = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

/** The period a dataset asks for, from the query, refusing what's missing. A year defaults to the current one. */
function resolvePeriod(period: ExportPeriod, request: ExportRequest) {
  const today = todayAsEntryDate();
  if (period === 'range' && (!request.from || !request.to)) throw missingInput(request.from ? 'to' : 'from', 'is required for this export');
  if (period === 'date' && !request.to) throw missingInput('to', 'is required for this export');
  return { from: request.from ?? today, to: request.to ?? today, year: request.year ?? financialYearOf(today) };
}

/** "profit-and-loss-2026-11-01-to-2026-11-30.csv", so downloads sort and don't overwrite each other. */
function fileNameOf(dataset: ExportDataset, query: { from: string; to: string; year: number }): string {
  const suffix = { range: `-${query.from}-to-${query.to}`, date: `-${query.to}`, year: `-${query.year}-${query.year + 1}`, none: `-${todayAsEntryDate()}` }[dataset.period];
  return `${dataset.key}${suffix}.csv`;
}

/**
 * One dataset as a CSV file, with the rows its screen would show this person and without any column for a field
 * their profile hides. Every download is written to the audit log, because exported data leaves the system.
 */
export async function exportDataset(actor: Actor, key: string, request: ExportRequest): Promise<{ fileName: string; csv: string }> {
  const dataset = EXPORT_DATASETS.find((candidate) => candidate.key === key);
  if (!dataset) throw new ApiError(404, 'unknown_export', 'No such export.');
  if (!mayExport(actor, dataset)) throw new ApiError(403, 'forbidden', `You need ${dataset.permission} to export ${dataset.label.toLowerCase()}.`);
  const rules = await readFieldRules(actor, ACCOUNTS_MODULE_KEY, dataset.resource);
  if (dataset.requiresField && rules.hidden.includes(dataset.requiresField)) {
    throw new ApiError(403, 'field_hidden', `Your profile hides the field this export is made of, so there is nothing to export.`);
  }

  const query = resolvePeriod(dataset.period, request);
  const columns = dataset.columns.filter((column) => !column.field || !rules.hidden.includes(column.field));
  const rows = await dataset.load(actor, query);
  const fileName = fileNameOf(dataset, query);
  await recordAudit({ action: 'accounts.exported', ...actorFields(actor), targetType: 'export', targetId: dataset.key, targetName: fileName, module: ACCOUNTS_MODULE_KEY });
  return { fileName, csv: toCsv(columns.map((column) => column.header), rows.map((row) => columns.map((column) => column.value(row)))) };
}
