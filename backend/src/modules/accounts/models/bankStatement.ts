import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** open: lines are being matched. reconciled: every difference explained and signed off; never changed again. */
export const BANK_STATEMENT_STATUSES = ['open', 'reconciled'] as const;
export type BankStatementStatus = (typeof BANK_STATEMENT_STATUSES)[number];

/** One line of the bank's statement, from its CSV. */
export interface StatementLine {
  /** Unique within the statement, such as sl_3. */
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  reference?: string;
  /** Paisa, signed: money into the account is positive, money out negative. */
  amount: number;
  /** The ledger entry this line matches: the same money, seen from the books. */
  matchedEntryId?: string;
  matchedBy?: string;
  matchedAt?: Date;
}

/**
 * A bank statement for one cash or bank account and period, loaded from the bank's CSV (decision 8) and matched
 * line by line against the account's ledger lines. The books are never changed here: a line missing from the books,
 * such as a bank charge, is recorded with an ordinary voucher and then matched.
 */
export interface BankStatementDoc extends RecordFields {
  _id: string;
  /** BR-0001 and so on. */
  number: string;
  accountId: string;
  /** The statement's first and last day, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Paisa: the bank's balance at the start and end of the period, as the statement says. */
  openingBalance: number;
  closingBalance: number;
  fileName?: string;
  lines: StatementLine[];
  status: BankStatementStatus;
  reconciledBy?: string;
  reconciledAt?: Date;
}

const lineSchema = new Schema<StatementLine>(
  {
    id: { type: String, required: true },
    date: { type: String, required: true },
    description: { type: String, required: true },
    reference: String,
    amount: { type: Number, required: true },
    matchedEntryId: String,
    matchedBy: String,
    matchedAt: Date,
  },
  { _id: false },
);

const bankStatementSchema = new Schema<BankStatementDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    accountId: { type: String, required: true, index: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    openingBalance: { type: Number, required: true },
    closingBalance: { type: Number, required: true },
    fileName: String,
    lines: { type: [lineSchema], required: true },
    status: { type: String, enum: BANK_STATEMENT_STATUSES, required: true },
    reconciledBy: String,
    reconciledAt: Date,
  },
  { timestamps: true },
);

addRecordFields(bankStatementSchema);

// A ledger entry matches at most one statement line, across every statement.
bankStatementSchema.index({ 'lines.matchedEntryId': 1 }, { sparse: true });

export const BankStatement = model<BankStatementDoc>('AccountsBankStatement', bankStatementSchema, 'accounts_bank_statements');
