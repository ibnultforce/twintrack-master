import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import {
  assertCanReachRecord,
  findSharedRecordIds,
  findSharingModel,
  listRecordShares,
  shareRecord,
  unshareRecord,
  type RecordNeed,
  type ShareInput,
} from '../../master/records/recordAccess.service.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUserById } from '../../master/users/users.repository.js';
import type { SalaryDoc } from '../models/salary.js';
import {
  approveSalary as saveApproval,
  deleteSalary as moveSalaryToRecycleBin,
  findEmployeeNames,
  findSalariesPage,
  findSalaryById,
  insertSalary,
  restoreSalary as takeSalaryOutOfRecycleBin,
  salaryNotFound,
  updateSalary as saveSalaryChanges,
  type NewSalaryRecord,
  type SalaryChanges,
} from './salary.repository.js';

const HR_MODULE_KEY = 'hr';
const SALARY_RESOURCE = 'salary';
const DEFAULT_CURRENCY = 'BDT';

export type NewSalaryDetails = Pick<NewSalaryRecord, 'employeeId' | 'amount' | 'effectiveFrom'> & { currency?: string };

const employeesInScope = (actor: Actor, scope: Scope) => peopleInScope(actor.user._id, scope);
const historyRef = (salaryId: string) => ({ module: HR_MODULE_KEY, object: SALARY_RESOURCE, recordId: salaryId });
/** A salary belongs to its employee, so their place in the org tree decides whose scope reaches it. */
const fieldRulesFor = (actor: Actor) => readFieldRules(actor, HR_MODULE_KEY, SALARY_RESOURCE);
const scopedSalary = (salary: SalaryDoc) => ({ ...historyRef(salary._id), peopleIds: [salary.employeeId] });

async function assertInScope(actor: Actor, scope: Scope, employeeId: string): Promise<void> {
  const employeeIds = await employeesInScope(actor, scope);
  if (employeeIds && !employeeIds.includes(employeeId)) {
    throw new ApiError(403, 'out_of_scope', 'This person is outside what your access reaches.');
  }
}

async function requireSalary(salaryId: string, options: { withDeleted?: boolean } = {}): Promise<SalaryDoc> {
  const salary = await findSalaryById(salaryId, options);
  if (!salary) throw salaryNotFound();
  return salary;
}

/** The salary as this person may see it: protected fields they have no access to are left out. */
function toSalaryView(salary: SalaryDoc, employeeName: string | undefined, rules: FieldRules) {
  return redactRecord({
    id: salary._id,
    employeeId: salary.employeeId,
    employeeName,
    amount: salary.amount,
    currency: salary.currency,
    effectiveFrom: salary.effectiveFrom,
    status: salary.status,
    approvedBy: salary.approvedBy,
    approvedAt: salary.approvedAt,
    version: salary.version,
    createdBy: salary.createdBy,
    createdAt: salary.createdAt,
    updatedBy: salary.updatedBy,
    updatedAt: salary.updatedAt,
    ...(salary.deletedAt && { deletedAt: salary.deletedAt, deletedBy: salary.deletedBy }),
  }, rules);
}

// Leaves amounts out, because people can read the activity log without being allowed to see salaries.
const salaryAuditFields = (actor: Actor, salary: SalaryDoc, employeeName?: string) => ({
  ...actorFields(actor),
  targetType: SALARY_RESOURCE,
  targetId: salary._id,
  targetName: employeeName,
  module: HR_MODULE_KEY,
});

/** The recycle bin holds deleted salaries, which only someone who can delete them may see. */
function assertMayUseRecycleBin(actor: Actor): void {
  if (!actor.permissions['salary.delete']) throw new ApiError(403, 'forbidden', 'Seeing deleted salaries needs salary.delete.');
}

export async function listSalaries(actor: Actor, scope: Scope, page: PageRequest & { deleted?: boolean }) {
  const { deleted = false, ...pageRequest } = page;
  if (deleted) assertMayUseRecycleBin(actor);
  const sharingModel = await findSharingModel(HR_MODULE_KEY, SALARY_RESOURCE);
  // A public sharing model, or a scope of everyone, reaches every salary. Otherwise shares add to what the scope reaches.
  const employeeIds = sharingModel === 'private' ? await employeesInScope(actor, scope) : null;
  const sharedIds = employeeIds ? await findSharedRecordIds(actor.user, HR_MODULE_KEY, SALARY_RESOURCE, 'read') : [];
  const { salaries, total } = await findSalariesPage({ ...pageRequest, inRecycleBin: deleted, ...(employeeIds && { employeeIds, sharedIds }) });
  const people = await findEmployeeNames([...new Set(salaries.map((salary) => salary.employeeId))]);
  const nameOf = new Map(people.map((person) => [person._id, person.name]));
  const rules = await fieldRulesFor(actor);
  return { scope, total, salaries: salaries.map((salary) => toSalaryView(salary, nameOf.get(salary.employeeId), rules)) };
}

export async function createSalary(actor: Actor, scope: Scope, details: NewSalaryDetails) {
  const employee = await findUserById(details.employeeId);
  if (!employee) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'employeeId', message: 'no such person' }]);
  }
  await assertInScope(actor, scope, employee._id);
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');

  const salary = await runInTransaction(async (session) => {
    const created = await insertSalary({ _id: `s_${randomUUID()}`, ...details, currency: details.currency ?? DEFAULT_CURRENCY }, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'salary.created', ...salaryAuditFields(actor, created, employee.name) }, session);
    return created;
  });
  return toSalaryView(salary, employee.name, rules);
}

/** Runs one change to an existing salary in scope, with its history and activity log entry in the same transaction. */
async function changeSalary(
  actor: Actor,
  scope: Scope,
  salaryId: string,
  change: {
    auditAction: string;
    historyAction: 'updated' | 'deleted' | 'restored';
    /** Editing can also come from a share. Approving, deleting and restoring follow the scope alone. */
    need?: RecordNeed;
    withDeleted?: boolean;
    save: (session: ClientSession) => Promise<SalaryDoc>;
    /** Fields the change sets, which need edit access when they're protected. Create access isn't enough here. */
    writes?: string[];
  },
) {
  const existing = await requireSalary(salaryId, { withDeleted: change.withDeleted });
  if (change.need) await assertCanReachRecord(actor, scope, scopedSalary(existing), change.need);
  else await assertInScope(actor, scope, existing.employeeId);
  // After the reach check, so someone outside it learns nothing about the fields.
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, change.writes ?? [], 'update');
  const employee = await findUserById(existing.employeeId);

  const saved = await runInTransaction(async (session) => {
    const result = await change.save(session);
    await writeRecordHistory(historyRef(salaryId), { action: change.historyAction, actor, before: existing, after: result }, session);
    await recordAudit({ action: change.auditAction, ...salaryAuditFields(actor, existing, employee?.name) }, session);
    return result;
  });
  return toSalaryView(saved, employee?.name, rules);
}

export function updateSalary(actor: Actor, scope: Scope, salaryId: string, changes: SalaryChanges & { version?: number }) {
  const { version, ...fields } = changes;
  return changeSalary(actor, scope, salaryId, {
    auditAction: 'salary.updated',
    historyAction: 'updated',
    need: 'edit',
    writes: Object.keys(fields),
    save: (session) => saveSalaryChanges(salaryId, fields, { actorId: actor.user._id, expectedVersion: version, session }),
  });
}

export async function approveSalary(actor: Actor, scope: Scope, salaryId: string, version?: number) {
  const existing = await requireSalary(salaryId);
  if (existing.status === 'approved') {
    await assertInScope(actor, scope, existing.employeeId);
    return toSalaryView(existing, (await findUserById(existing.employeeId))?.name, await fieldRulesFor(actor));
  }
  return changeSalary(actor, scope, salaryId, {
    auditAction: 'salary.approved',
    historyAction: 'updated',
    save: (session) => saveApproval(salaryId, { actorId: actor.user._id, expectedVersion: version, session }),
  });
}

/** Moves a salary to the recycle bin. It keeps its history, and can be restored. */
export function deleteSalary(actor: Actor, scope: Scope, salaryId: string) {
  return changeSalary(actor, scope, salaryId, {
    auditAction: 'salary.deleted',
    historyAction: 'deleted',
    save: (session) => moveSalaryToRecycleBin(salaryId, { actorId: actor.user._id, session }),
  });
}

export function restoreSalary(actor: Actor, scope: Scope, salaryId: string) {
  return changeSalary(actor, scope, salaryId, {
    auditAction: 'salary.restored',
    historyAction: 'restored',
    withDeleted: true,
    save: (session) => takeSalaryOutOfRecycleBin(salaryId, { actorId: actor.user._id, session }),
  });
}

/** What changed and who changed it. Holds amounts, so it follows the same reach as reading the salary. */
export async function getSalaryHistory(actor: Actor, scope: Scope, salaryId: string, page: PageRequest) {
  const salary = await requireSalary(salaryId, { withDeleted: Boolean(actor.permissions['salary.delete']) });
  await assertCanReachRecord(actor, scope, scopedSalary(salary), 'read');
  const history = await listRecordHistory(historyRef(salaryId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}

/** Who a salary is shared with. Anyone who can read the salary can see this. */
export async function listSalaryShares(actor: Actor, scope: Scope, salaryId: string) {
  const salary = await requireSalary(salaryId);
  await assertCanReachRecord(actor, scope, scopedSalary(salary), 'read');
  return listRecordShares(historyRef(salaryId));
}

export async function shareSalary(actor: Actor, salaryId: string, input: ShareInput) {
  return shareRecord(actor, scopedSalary(await requireSalary(salaryId)), input);
}

export async function unshareSalary(actor: Actor, salaryId: string, shareId: string) {
  return unshareRecord(actor, scopedSalary(await requireSalary(salaryId)), shareId);
}
