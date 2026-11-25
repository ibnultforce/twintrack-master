import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * draft: made from the active employees; may be edited.
 * submitted: waiting for someone other than its maker.
 * recorded: approved, and recorded as salary expense per person against salaries payable.
 * cancelled: a draft given up, or a recorded run reversed in the ledger. The month can then be run again.
 * Paid is worked out from the payment vouchers linked to it, never stored.
 */
export const PAYROLL_RUN_STATUSES = ['draft', 'submitted', 'recorded', 'cancelled'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/** One loan or advance instalment taken from a person's pay. */
export interface LoanRepayment {
  loanId: string;
  /** LN-0001, so the line shows it without a lookup. */
  number: string;
  /** Paisa. */
  amount: number;
}

/**
 * One person's pay in the run. Tax and provident fund deductions come later in Day 5; unpaid leave and loan
 * repayments are taken here.
 */
export interface PayrollLine {
  employeeId: string;
  employeeCode: string;
  name: string;
  department: string;
  /** Paisa earned: the monthly salary, less any part month or unpaid leave. Recorded as salary expense. */
  gross: number;
  /** Unpaid leave days in the month, and the pay they took off (salary ÷ 30 a day). */
  unpaidLeaveDays?: number;
  leaveDeduction?: number;
  /** Loan and advance instalments taken from the pay. */
  loanRepayments?: LoanRepayment[];
  /** Paisa the person is paid: gross less loan repayments. Runs saved before deductions existed have none: net is gross. */
  net?: number;
  note?: string;
}

export interface PayrollRunDoc extends RecordFields {
  _id: string;
  /** PR-0001 and so on. */
  number: string;
  /** The month paid, YYYY-MM. One run per month that isn't cancelled. */
  month: string;
  /** When salaries are paid, YYYY-MM-DD. The run is overdue from the day after. */
  payDate: string;
  /** Salaries per person. A protected field: hidden unless a profile's grant names it. */
  lines: PayrollLine[];
  /** Paisa: the sum of the lines' gross. Visible to anyone who can read payroll. */
  total: number;
  /** Paisa paid from the bank: the sum of the lines' net. Missing on runs saved before deductions: the same as total. */
  netTotal?: number;
  headcount: number;
  status: PayrollRunStatus;
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

const lineSchema = new Schema<PayrollLine>(
  {
    employeeId: { type: String, required: true },
    employeeCode: { type: String, required: true },
    name: { type: String, required: true },
    department: { type: String, required: true },
    gross: { type: Number, required: true },
    unpaidLeaveDays: Number,
    leaveDeduction: Number,
    loanRepayments: {
      type: [new Schema<LoanRepayment>({ loanId: { type: String, required: true }, number: { type: String, required: true }, amount: { type: Number, required: true } }, { _id: false })],
      default: undefined,
    },
    net: Number,
    note: String,
  },
  { _id: false },
);

const payrollRunSchema = new Schema<PayrollRunDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    month: { type: String, required: true },
    payDate: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    total: { type: Number, required: true },
    netTotal: Number,
    headcount: { type: Number, required: true },
    status: { type: String, enum: PAYROLL_RUN_STATUSES, required: true, index: true },
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

addRecordFields(payrollRunSchema);

// One live run per month: a second is refused by the database too, not only by the check before saving.
payrollRunSchema.index({ month: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['draft', 'submitted', 'recorded'] } } });

export const PayrollRun = model<PayrollRunDoc>('AccountsPayrollRun', payrollRunSchema, 'accounts_payroll_runs');
