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

/**
 * journal: any balanced lines, numbered JV.
 * payment: money paid out of one cash or bank account, numbered PV. Its lines debit what was paid for.
 * receipt: money received into one cash or bank account, numbered RV. Its lines credit what it was received for.
 * All three share one collection, one approval flow and the journalVoucher permissions.
 */
export const VOUCHER_TYPES = ['journal', 'payment', 'receipt'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/** What a voucher settles or comes from: an invoice, a bill or a payroll run it pays, or a month's depreciation run. */
export const LINKED_DOCUMENT_TYPES = ['invoice', 'bill', 'payrollRun', 'staffPayout', 'employeeLoan', 'providentFund', 'taxFiling', 'depreciation'] as const;
export type LinkedDocumentType = (typeof LINKED_DOCUMENT_TYPES)[number];

export interface LinkedDocument {
  type: LinkedDocumentType;
  id: string;
  /** INV-0001 or B-0001, so lists can show it without a lookup. */
  number: string;
  /** How much of the document it settles, in the document's currency, minor units (cents or paisa). */
  amount: number;
  /**
   * What the document was owed in all when the voucher was made. Approval refuses the voucher if recorded payments
   * would pass it, so two payments made at the same moment can't both reach the books. Vouchers made before this
   * existed, and depreciation runs, have none.
   */
  amountDue?: number;
}

/** A manual journal entry that needs a second person's approval before it reaches the ledger. */
export interface JournalVoucherDoc extends RecordFields {
  _id: string;
  /** Vouchers saved before payment and receipt vouchers existed have none, and are journal vouchers. */
  voucherType: VoucherType;
  /** JV-0001, PV-0001 or RV-0001, one series per type, handed out once and never reused. */
  number: string;
  /** The accounting date, YYYY-MM-DD. */
  voucherDate: string;
  memo: string;
  /** Who was paid, or who paid. Required on payment and receipt vouchers. */
  party?: string;
  /** The outside document it refers to, such as a cheque or bill number. */
  reference?: string;
  /** The cash or bank account a payment came out of or a receipt went into. Set on payment and receipt vouchers only. */
  moneyAccountId?: string;
  /**
   * The invoice or bill this payment or receipt settles. Set by that document's Receive payment or Pay action and
   * never edited: a wrong one is reversed and made again, so the document's paid amount always matches the books.
   */
  linkedDocument?: LinkedDocument;
  /** The full balanced ledger lines, including the cash or bank line of a payment or receipt. */
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
    voucherType: { type: String, enum: VOUCHER_TYPES, required: true, default: 'journal', index: true },
    number: { type: String, required: true, unique: true },
    voucherDate: { type: String, required: true },
    memo: { type: String, required: true },
    party: String,
    reference: String,
    moneyAccountId: String,
    linkedDocument: {
      type: new Schema<LinkedDocument>(
        {
          type: { type: String, enum: LINKED_DOCUMENT_TYPES, required: true },
          id: { type: String, required: true },
          number: { type: String, required: true },
          amount: { type: Number, required: true },
          amountDue: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
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

journalVoucherSchema.index({ 'linkedDocument.id': 1, status: 1 });

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
