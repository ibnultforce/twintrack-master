import type { ClientSession } from 'mongoose';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { User } from '../../master/models/user.js';
import { Salary, type SalaryDoc } from '../models/salary.js';

export type NewSalaryRecord = Pick<SalaryDoc, '_id' | 'employeeId' | 'amount' | 'currency' | 'effectiveFrom'>;
export type SalaryChanges = Partial<Pick<SalaryDoc, 'amount' | 'currency' | 'effectiveFrom'>>;
export type SalarySeedRow = NewSalaryRecord & { status: SalaryDoc['status'] };

export async function findSalariesPage({ employeeIds, ...page }: PageRequest & { employeeIds?: string[] }) {
  const filter = employeeIds ? { employeeId: { $in: employeeIds } } : {};
  const [salaries, total] = await Promise.all([
    Salary.find(filter).sort({ effectiveFrom: -1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Salary.countDocuments(filter),
  ]);
  return { salaries, total };
}

export function findSalaryById(salaryId: string) {
  return Salary.findById(salaryId).lean();
}

export async function insertSalary(record: NewSalaryRecord, session: ClientSession): Promise<SalaryDoc> {
  const [created] = await Salary.create([record], { session });
  if (!created) throw new Error('Creating the salary returned nothing.');
  return created.toObject();
}

export function updateSalary(salaryId: string, changes: SalaryChanges, session: ClientSession) {
  return Salary.findByIdAndUpdate(
    salaryId,
    { $set: { ...changes, status: 'pending' }, $unset: { approvedBy: 1, approvedAt: 1 } },
    { returnDocument: 'after', session },
  ).lean();
}

export function approveSalary(salaryId: string, approverId: string, session: ClientSession) {
  return Salary.findByIdAndUpdate(
    salaryId,
    { $set: { status: 'approved', approvedBy: approverId, approvedAt: new Date() } },
    { returnDocument: 'after', session },
  ).lean();
}

export function findReportIds(managerId: string): Promise<string[]> {
  return User.find({ managerId }).distinct('_id');
}

export function findEmployeeNames(employeeIds: string[]) {
  return User.find({ _id: { $in: employeeIds } }).select('name').lean();
}

/** Creates or updates sample salaries by id, so the seed is safe to re-run. */
export async function upsertSalaries(rows: SalarySeedRow[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await Salary.bulkWrite(
    rows.map(({ _id, ...row }) => ({ updateOne: { filter: { _id }, update: { $set: row }, upsert: true } })),
    { session },
  );
}
