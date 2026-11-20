import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * A person payroll pays. HR isn't built yet, so these are dummy employees loaded from
 * seed/accounts-employees.json, and payroll (plan Day 3) reads them. Salaries are integer paisa.
 */
export interface AccountsEmployeeDoc extends RecordFields {
  _id: string;
  /** The number people quote, such as EMP-001. Unique. */
  employeeCode: string;
  name: string;
  designation: string;
  department: string;
  /** YYYY-MM-DD. */
  joinDate: string;
  /** Monthly gross salary in paisa. Must be a protected field once a route shows it. */
  monthlySalary: number;
  bankAccountNumber?: string;
  isActive: boolean;
}

const accountsEmployeeSchema = new Schema<AccountsEmployeeDoc>(
  {
    _id: { type: String, required: true },
    employeeCode: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    designation: { type: String, required: true },
    department: { type: String, required: true },
    joinDate: { type: String, required: true },
    monthlySalary: { type: Number, required: true },
    bankAccountNumber: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

addRecordFields(accountsEmployeeSchema);

export const AccountsEmployee = model<AccountsEmployeeDoc>('AccountsEmployee', accountsEmployeeSchema, 'accounts_employees');
