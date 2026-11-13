import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const PAYROLL_RUN_STATUSES = ['draft', 'pending_approval', 'approved', 'completed'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const SETTLEMENT_STATUSES = ['unpaid', 'paid', 'failed', 'returned'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * One person's pay in a run, copied when the run is made, so later salary changes don't change a run already made.
 * Pay is the HR salary in effect at the end of the month, plus the month's unpaid monthly incentive from Tasks.
 */
export interface PayrollItem {
  _id: string;
  userId: string;
  /** The HR salary record it was copied from. */
  salaryId: string;
  currency: string;
  salaryAmount: number;
  /** The month's Tasks incentive, in taka. Zero when there is none, or when pay isn't in taka. */
  incentiveAmount: number;
  /** Set once paying this item has marked the incentive paid in Tasks, so settling it again doesn't look for it. */
  incentiveMarkedPaid?: boolean;
  deductions: number;
  grossAmount: number;
  netAmount: number;
  /** The bank account it's paid from: the run's, when that account is in this item's currency. */
  bankAccountId?: string;
  settlementStatus: SettlementStatus;
  settledAt?: Date;
  reference?: string;
  notes?: string;
}

export interface PayrollRunDoc extends RecordFields {
  _id: string;
  month: number;
  year: number;
  status: PayrollRunStatus;
  bankAccountId?: string;
  notes?: string;
  decidedBy?: string;
  decidedAt?: Date;
  /** Why the approver sent it back to draft, the last time they did. */
  returnReason?: string;
  items: PayrollItem[];
  /** Such as 2026-11, while the run isn't deleted. Unique, so a month has one run, and a deleted draft frees it. */
  activeMonth?: string;
}

const itemSchema = new Schema<PayrollItem>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    salaryId: { type: String, required: true },
    currency: { type: String, required: true },
    salaryAmount: { type: Number, required: true, min: 0 },
    incentiveAmount: { type: Number, default: 0, min: 0 },
    incentiveMarkedPaid: Boolean,
    deductions: { type: Number, default: 0, min: 0 },
    grossAmount: { type: Number, required: true },
    netAmount: { type: Number, required: true },
    bankAccountId: String,
    settlementStatus: { type: String, enum: SETTLEMENT_STATUSES, default: 'unpaid' },
    settledAt: Date,
    reference: String,
    notes: String,
  },
  { _id: false },
);

const payrollRunSchema = new Schema<PayrollRunDoc>(
  {
    _id: { type: String, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    status: { type: String, enum: PAYROLL_RUN_STATUSES, default: 'draft' },
    bankAccountId: String,
    notes: String,
    decidedBy: String,
    decidedAt: Date,
    returnReason: String,
    items: { type: [itemSchema], default: [] },
    activeMonth: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);
payrollRunSchema.index({ year: 1, month: 1 });
payrollRunSchema.index({ 'items.userId': 1 });
addRecordFields(payrollRunSchema);
export const PayrollRun = model<PayrollRunDoc>('AccountsPayrollRun', payrollRunSchema, 'accounts_payroll_runs');
