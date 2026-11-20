import type { ClientSession } from 'mongoose';
import { AccountsEmployee, type AccountsEmployeeDoc } from '../models/accountsEmployee.js';

export type EmployeeSeedRow = Pick<
  AccountsEmployeeDoc,
  '_id' | 'employeeCode' | 'name' | 'designation' | 'department' | 'joinDate' | 'monthlySalary' | 'bankAccountNumber' | 'isActive'
>;

/** Adds the seed employees that aren't in the database yet. Employees already there are left as they are. */
export async function insertMissingEmployees(rows: EmployeeSeedRow[], session: ClientSession): Promise<void> {
  if (rows.length === 0) return;
  await AccountsEmployee.bulkWrite(
    rows.map(({ _id, ...row }) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: { ...row, version: 0 } }, upsert: true } })),
    { session },
  );
}
