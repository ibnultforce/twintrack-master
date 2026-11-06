import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { findUserById } from '../../master/users/users.repository.js';
import type { SalaryDoc } from '../models/salary.js';
import {
  approveSalary as saveApproval,
  findEmployeeNames,
  findReportIds,
  findSalariesPage,
  findSalaryById,
  insertSalary,
  updateSalary as saveSalaryChanges,
  type NewSalaryRecord,
  type SalaryChanges,
} from './salary.repository.js';

const HR_MODULE_KEY = 'hr';
const DEFAULT_CURRENCY = 'BDT';

export type NewSalaryDetails = Pick<NewSalaryRecord, 'employeeId' | 'amount' | 'effectiveFrom'> & { currency?: string };

/** Who a permission's scope reaches. Null means everyone. */
async function employeesInScope(actor: Actor, scope: Scope): Promise<string[] | null> {
  if (scope === 'all') return null;
  if (scope === 'own') return [actor.user._id];
  return [actor.user._id, ...(await findReportIds(actor.user._id))];
}

async function assertInScope(actor: Actor, scope: Scope, employeeId: string): Promise<void> {
  const employeeIds = await employeesInScope(actor, scope);
  if (employeeIds && !employeeIds.includes(employeeId)) {
    throw new ApiError(403, 'out_of_scope', 'This person is outside what your role reaches.');
  }
}

async function requireSalary(salaryId: string): Promise<SalaryDoc> {
  const salary = await findSalaryById(salaryId);
  if (!salary) throw new ApiError(404, 'unknown_salary', 'No such salary.');
  return salary;
}

function toSalaryView(salary: SalaryDoc, employeeName?: string) {
  return {
    id: salary._id,
    employeeId: salary.employeeId,
    employeeName,
    amount: salary.amount,
    currency: salary.currency,
    effectiveFrom: salary.effectiveFrom,
    status: salary.status,
    approvedBy: salary.approvedBy,
    approvedAt: salary.approvedAt,
  };
}

// Leaves amounts out, because people can read the activity log without being allowed to see salaries.
const salaryAuditFields = (actor: Actor, salary: SalaryDoc, employeeName?: string) => ({
  ...actorFields(actor),
  targetType: 'salary',
  targetId: salary._id,
  targetName: employeeName,
  module: HR_MODULE_KEY,
});

export async function listSalaries(actor: Actor, scope: Scope, page: PageRequest) {
  const employeeIds = await employeesInScope(actor, scope);
  const { salaries, total } = await findSalariesPage({ ...page, ...(employeeIds && { employeeIds }) });
  const people = await findEmployeeNames([...new Set(salaries.map((salary) => salary.employeeId))]);
  const nameOf = new Map(people.map((person) => [person._id, person.name]));
  return { scope, total, salaries: salaries.map((salary) => toSalaryView(salary, nameOf.get(salary.employeeId))) };
}

export async function createSalary(actor: Actor, scope: Scope, details: NewSalaryDetails) {
  const employee = await findUserById(details.employeeId);
  if (!employee) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'employeeId', message: 'no such person' }]);
  }
  await assertInScope(actor, scope, employee._id);

  const salary = await runInTransaction(async (session) => {
    const created = await insertSalary({ _id: `s_${randomUUID()}`, ...details, currency: details.currency ?? DEFAULT_CURRENCY }, session);
    await recordAudit({ action: 'salary.created', ...salaryAuditFields(actor, created, employee.name) }, session);
    return created;
  });
  return toSalaryView(salary, employee.name);
}

export async function updateSalary(actor: Actor, scope: Scope, salaryId: string, changes: SalaryChanges) {
  const existing = await requireSalary(salaryId);
  await assertInScope(actor, scope, existing.employeeId);
  const employee = await findUserById(existing.employeeId);

  const updated = await runInTransaction(async (session) => {
    const saved = await saveSalaryChanges(salaryId, changes, session);
    await recordAudit({ action: 'salary.updated', ...salaryAuditFields(actor, existing, employee?.name) }, session);
    return saved;
  });
  if (!updated) throw new ApiError(404, 'unknown_salary', 'No such salary.');
  return toSalaryView(updated, employee?.name);
}

export async function approveSalary(actor: Actor, scope: Scope, salaryId: string) {
  const existing = await requireSalary(salaryId);
  await assertInScope(actor, scope, existing.employeeId);
  const employee = await findUserById(existing.employeeId);
  if (existing.status === 'approved') return toSalaryView(existing, employee?.name);

  const approved = await runInTransaction(async (session) => {
    const saved = await saveApproval(salaryId, actor.user._id, session);
    await recordAudit({ action: 'salary.approved', ...salaryAuditFields(actor, existing, employee?.name) }, session);
    return saved;
  });
  if (!approved) throw new ApiError(404, 'unknown_salary', 'No such salary.');
  return toSalaryView(approved, employee?.name);
}
