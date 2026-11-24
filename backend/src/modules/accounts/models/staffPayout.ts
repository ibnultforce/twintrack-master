import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * incentive: a month's incentives worked out by Project management, paid to TwinTrack people.
 * bonus: amounts typed per employee, such as an Eid or year-end bonus.
 * commission: what employees earned on money received from clients, under their commission rules.
 */
export const PAYOUT_KINDS = ['incentive', 'bonus', 'commission'] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export const PAYOUT_STATUSES = ['draft', 'submitted', 'recorded', 'cancelled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** One person's amount in the payout. */
export interface PayoutLine {
  /** user: a TwinTrack person (incentives). employee: one of the payroll employees (bonus, commission). */
  payeeType: 'user' | 'employee';
  payeeId: string;
  name: string;
  /** Paisa. */
  amount: number;
  note?: string;
  /** Commission only: the receipt vouchers it is earned on, so none is paid twice. */
  receiptIds?: string[];
}

/**
 * Bonus, incentive or commission paid to staff: draft, submitted, recorded (expense against salaries payable), then paid
 * with a linked payment voucher. Approving an incentive payout marks each person's month paid in Project management in
 * the same transaction, so an incentive can be paid only once.
 */
export interface StaffPayoutDoc extends RecordFields {
  _id: string;
  /** BI-0001 and so on. */
  number: string;
  kind: PayoutKind;
  title: string;
  /** Incentives: the month they were earned, YYYY-MM. */
  month?: string;
  /** YYYY-MM-DD. Recorded on this date; overdue from the day after. */
  payDate: string;
  lines: PayoutLine[];
  /** Paisa. */
  total: number;
  status: PayoutStatus;
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

const lineSchema = new Schema<PayoutLine>(
  {
    payeeType: { type: String, enum: ['user', 'employee'], required: true },
    payeeId: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    note: String,
    receiptIds: { type: [String], default: undefined },
  },
  { _id: false },
);

const staffPayoutSchema = new Schema<StaffPayoutDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    kind: { type: String, enum: PAYOUT_KINDS, required: true, index: true },
    title: { type: String, required: true },
    month: String,
    payDate: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: PAYOUT_STATUSES, required: true, index: true },
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

addRecordFields(staffPayoutSchema);

export const StaffPayout = model<StaffPayoutDoc>('AccountsStaffPayout', staffPayoutSchema, 'accounts_staff_payouts');

/** An employee's share of money received from one client, in basis points: 200 is 2%. */
export interface CommissionRuleDoc extends RecordFields {
  _id: string;
  employeeId: string;
  clientId: string;
  rateBasisPoints: number;
  /** Receipts on or after this date earn commission, YYYY-MM-DD. */
  startDate: string;
  isActive: boolean;
}

const commissionRuleSchema = new Schema<CommissionRuleDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true, index: true },
    clientId: { type: String, required: true, index: true },
    rateBasisPoints: { type: Number, required: true },
    startDate: { type: String, required: true },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

addRecordFields(commissionRuleSchema);

export const CommissionRule = model<CommissionRuleDoc>('AccountsCommissionRule', commissionRuleSchema, 'accounts_commission_rules');
