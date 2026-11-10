import type { ClientSession } from 'mongoose';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { ONLY_DELETED, WITH_DELETED } from '../../../lib/records/recordFields.js';
import { changeRecord, moveToRecycleBin, restoreFromRecycleBin } from '../../../lib/records/recordWrites.js';
import { ApiError } from '../../../lib/errors.js';
import { User } from '../../master/models/user.js';
import { Salary, type SalaryDoc } from '../models/salary.js';

export type NewSalaryRecord = Pick<SalaryDoc, '_id' | 'employeeId' | 'amount' | 'currency' | 'effectiveFrom'>;
export type SalaryChanges = Partial<Pick<SalaryDoc, 'amount' | 'currency' | 'effectiveFrom'>>;
export type SalarySeedRow = NewSalaryRecord & { status: SalaryDoc['status'] };

export const salaryNotFound = () => new ApiError(404, 'unknown_salary', 'No such salary.');

interface WriteContext {
  actorId: string;
  expectedVersion?: number;
  session: ClientSession;
}

interface SalaryListFilter {
  /** The people whose salaries are reached. Missing means everyone. */
  employeeIds?: string[];
  /** Salaries reached anyway, because they were shared. */
  sharedIds?: string[];
  inRecycleBin?: boolean;
}

/** Salaries of the given people plus those shared, or of everyone. `inRecycleBin` lists deleted ones instead. */
export async function findSalariesPage({ employeeIds, sharedIds = [], inRecycleBin = false, ...page }: PageRequest & SalaryListFilter) {
  const reach = employeeIds ? { $or: [{ employeeId: { $in: employeeIds } }, { _id: { $in: sharedIds } }] } : {};
  const filter = { ...reach, ...(inRecycleBin && ONLY_DELETED) };
  const [salaries, total] = await Promise.all([
    Salary.find(filter).sort({ effectiveFrom: -1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Salary.countDocuments(filter),
  ]);
  return { salaries, total };
}

/** Finds a salary, including one in the recycle bin when asked. */
export function findSalaryById(salaryId: string, { withDeleted = false } = {}) {
  return Salary.findById(salaryId).setOptions(withDeleted ? WITH_DELETED : {}).lean();
}

export async function insertSalary(record: NewSalaryRecord, createdBy: string, session: ClientSession): Promise<SalaryDoc> {
  const [created] = await Salary.create([{ ...record, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the salary returned nothing.');
  return created.toObject();
}

/** A change sends the salary back to pending, so it has to be approved again. */
export function updateSalary(salaryId: string, changes: SalaryChanges, context: WriteContext) {
  return changeRecord(Salary, salaryId, { $set: { ...changes, status: 'pending' }, $unset: { approvedBy: 1, approvedAt: 1 } }, context, salaryNotFound);
}

export function approveSalary(salaryId: string, context: WriteContext) {
  return changeRecord(Salary, salaryId, { $set: { status: 'approved', approvedBy: context.actorId, approvedAt: new Date() } }, context, salaryNotFound);
}

export const deleteSalary = (salaryId: string, context: WriteContext) => moveToRecycleBin(Salary, salaryId, context, salaryNotFound);

export const restoreSalary = (salaryId: string, context: WriteContext) => restoreFromRecycleBin(Salary, salaryId, context, salaryNotFound);

export function findEmployeeNames(employeeIds: string[]) {
  return User.find({ _id: { $in: employeeIds } }).select('name').lean();
}

/** Creates or updates sample salaries by id, so the seed is safe to re-run. */
export async function upsertSalaries(rows: SalarySeedRow[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await Salary.bulkWrite(
    rows.map(({ _id, ...row }) => ({
      updateOne: { filter: { _id }, update: { $set: row, $unset: { deletedAt: 1, deletedBy: 1 } }, upsert: true },
    })),
    { session },
  );
}
