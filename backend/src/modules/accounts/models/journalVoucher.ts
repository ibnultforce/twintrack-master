import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';
import type { LedgerLine } from './ledgerEntry.js';

/**
 * draft: the maker is still writing it, and may edit it.
 * submitted: waiting for someone else to approve or return it.
 * recorded: approved, and written to the ledger. Never edited again.
 * reversed: a reversal in the ledger has cancelled it.
 */
export const JOURNAL_VOUCHER_STATUSES = ['draft', 'submitted', 'recorded', 'reversed'] as const;
export type JournalVoucherStatus = (typeof JOURNAL_VOUCHER_STATUSES)[number];

/** A manual journal entry that needs a second person's approval before it reaches the ledger. */
export interface JournalVoucherDoc extends RecordFields {
  _id: string;
  /** JV-0001 and so on, handed out once and never reused. */
  number: string;
  /** The accounting date, YYYY-MM-DD. */
  voucherDate: string;
  memo: string;
  lines: LedgerLine[];
  /** The sum of the debits, which equals the sum of the credits. */
  total: number;
  status: JournalVoucherStatus;
  submittedBy?: string;
  submittedAt?: Date;
  /** Why the approver sent it back, shown to the maker. Cleared when it is submitted again. */
  returnNote?: string;
  approvedBy?: string;
  approvedAt?: Date;
  ledgerEntryId?: string;
  reversedBy?: string;
  reversedAt?: Date;
  reversalEntryId?: string;
}

const lineSchema = new Schema<LedgerLine>(
  { accountId: { type: String, required: true }, debit: { type: Number, required: true }, credit: { type: Number, required: true }, memo: String },
  { _id: false },
);

const journalVoucherSchema = new Schema<JournalVoucherDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    voucherDate: { type: String, required: true },
    memo: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: JOURNAL_VOUCHER_STATUSES, required: true, index: true },
    submittedBy: String,
    submittedAt: Date,
    returnNote: String,
    approvedBy: String,
    approvedAt: Date,
    ledgerEntryId: String,
    reversedBy: String,
    reversedAt: Date,
    reversalEntryId: String,
  },
  { timestamps: true },
);

addRecordFields(journalVoucherSchema);

export const JournalVoucher = model<JournalVoucherDoc>('AccountsJournalVoucher', journalVoucherSchema, 'accounts_journal_vouchers');

/** The last voucher number handed out, per series. Taken outside the voucher's transaction, so a number is never handed out twice. */
interface VoucherCounterDoc {
  _id: string;
  lastNumber: number;
}

export const VoucherCounter = model<VoucherCounterDoc>(
  'AccountsVoucherCounter',
  new Schema<VoucherCounterDoc>({ _id: { type: String, required: true }, lastNumber: { type: Number, required: true, default: 0 } }),
  'accounts_voucher_counters',
);
