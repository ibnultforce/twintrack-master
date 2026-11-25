import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** loan: repaid over several months, such as a house loan. advance: a short advance on salary or for travel. */
export const LOAN_KINDS = ['loan', 'advance'] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];

/**
 * draft: being written. submitted: waiting for someone other than its maker. recorded: approved, and recorded as owed
 * by the employee (1400 Employee advances and loans) against salaries payable, then paid out with a linked voucher.
 * cancelled: a draft given up, or a recorded loan with nothing paid or repaid, reversed.
 * What is still owed is worked out from repayments in recorded payroll runs, never stored.
 */
export const LOAN_STATUSES = ['draft', 'submitted', 'recorded', 'cancelled'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export interface EmployeeLoanDoc extends RecordFields {
  _id: string;
  /** LN-0001 and so on. */
  number: string;
  employeeId: string;
  /** Copied from the employee when it is saved. */
  employeeName: string;
  kind: LoanKind;
  purpose: string;
  /** YYYY-MM-DD: when the money is given. */
  issueDate: string;
  /** Paisa. */
  amount: number;
  /** Paisa taken from each payroll until it is repaid; the last one takes what is left. */
  monthlyInstallment: number;
  /** The first payroll month that repays it, YYYY-MM. */
  firstRepaymentMonth: string;
  status: LoanStatus;
  submittedBy?: string;
  submittedAt?: Date;
  returnNote?: string;
  approvedBy?: string;
  approvedAt?: Date;
  ledgerEntryId?: string;
  cancelledBy?: string;
  cancelledAt?: Date;
  reversalEntryId?: string;
}

const employeeLoanSchema = new Schema<EmployeeLoanDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    employeeId: { type: String, required: true, index: true },
    employeeName: { type: String, required: true },
    kind: { type: String, enum: LOAN_KINDS, required: true },
    purpose: { type: String, required: true },
    issueDate: { type: String, required: true },
    amount: { type: Number, required: true },
    monthlyInstallment: { type: Number, required: true },
    firstRepaymentMonth: { type: String, required: true },
    status: { type: String, enum: LOAN_STATUSES, required: true, index: true },
    submittedBy: String,
    submittedAt: Date,
    returnNote: String,
    approvedBy: String,
    approvedAt: Date,
    ledgerEntryId: String,
    cancelledBy: String,
    cancelledAt: Date,
    reversalEntryId: String,
  },
  { timestamps: true },
);

addRecordFields(employeeLoanSchema);

export const EmployeeLoan = model<EmployeeLoanDoc>('AccountsEmployeeLoan', employeeLoanSchema, 'accounts_employee_loans');

/**
 * Unpaid leave a person took in a month, which the month's payroll deducts at a day's pay (monthly salary ÷ 30).
 * Kept here until HR is built and records leave itself.
 */
export interface UnpaidLeaveDoc extends RecordFields {
  /** `${employeeId}:${month}`: one record per person and month. */
  _id: string;
  employeeId: string;
  /** YYYY-MM. */
  month: string;
  /** Whole or half days. */
  days: number;
  note?: string;
}

const unpaidLeaveSchema = new Schema<UnpaidLeaveDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    month: { type: String, required: true, index: true },
    days: { type: Number, required: true },
    note: String,
  },
  { timestamps: true },
);

addRecordFields(unpaidLeaveSchema);

export const UnpaidLeave = model<UnpaidLeaveDoc>('AccountsUnpaidLeave', unpaidLeaveSchema, 'accounts_unpaid_leave');
