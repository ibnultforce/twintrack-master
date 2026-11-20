import { Schema, model } from 'mongoose';

/** One side of a ledger entry. Exactly one of debit and credit is above zero. Amounts are whole paisa or cents. */
export interface LedgerLine {
  accountId: string;
  debit: number;
  credit: number;
  memo?: string;
}

/** The record that caused an entry, such as a voucher or a bill, so the ledger can be traced back to it. */
export interface LedgerEntrySource {
  type: string;
  id: string;
}

/**
 * One balanced journal entry. Entries are written only by `postEntry` and `reverseEntry` in `ledger/`, and never
 * edited or deleted afterwards: a mistake is corrected by a reversal, which is a new entry with the lines mirrored.
 * So unlike other business records this one has no version, soft delete or updatedBy.
 */
export interface LedgerEntryDoc {
  _id: string;
  /** The accounting date, as YYYY-MM-DD, so it never shifts with time zones. */
  entryDate: string;
  memo: string;
  source: LedgerEntrySource;
  lines: LedgerLine[];
  /** The sum of the debits, which equals the sum of the credits. */
  total: number;
  /** Set on a reversal: the entry it cancels. */
  reversalOf?: string;
  /** Set on an entry once it has been reversed: the reversal's id. */
  reversedBy?: string;
  createdBy: string;
  createdAt: Date;
}

const ledgerLineSchema = new Schema<LedgerLine>(
  {
    accountId: { type: String, required: true },
    debit: { type: Number, required: true, min: 0 },
    credit: { type: Number, required: true, min: 0 },
    memo: String,
  },
  { _id: false },
);

const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    _id: { type: String, required: true },
    entryDate: { type: String, required: true, index: true },
    memo: { type: String, required: true },
    source: { required: true, type: new Schema<LedgerEntrySource>({ type: { type: String, required: true }, id: { type: String, required: true } }, { _id: false }) },
    lines: { type: [ledgerLineSchema], required: true },
    total: { type: Number, required: true },
    reversalOf: String,
    reversedBy: String,
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ 'lines.accountId': 1, entryDate: 1 });
// A second reversal of the same entry is refused by the database too, not only by the service's check.
ledgerEntrySchema.index({ reversalOf: 1 }, { unique: true, partialFilterExpression: { reversalOf: { $type: 'string' } } });

export const LedgerEntry = model<LedgerEntryDoc>('AccountsLedgerEntry', ledgerEntrySchema, 'accounts_ledger_entries');
