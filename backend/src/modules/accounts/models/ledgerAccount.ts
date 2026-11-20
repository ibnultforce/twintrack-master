import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const LEDGER_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

/** Which side increases an account of each type. Assets and expenses grow with debits; the rest with credits. */
export const NORMAL_BALANCE: Record<LedgerAccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

/**
 * One account in the chart of accounts. Ledger lines will name accounts by id, so an account is never deleted:
 * it is deactivated instead. A parent groups accounts of the same type, such as "Bank accounts" under "Assets".
 */
export interface LedgerAccountDoc extends RecordFields {
  _id: string;
  /** A short number people quote, such as 1200. Unique across the chart. */
  code: string;
  name: string;
  type: LedgerAccountType;
  parentId?: string;
  description?: string;
  /** For a box that is a real bank account. A protected field: hidden unless a profile's grant names it. */
  bankAccountNumber?: string;
  isActive: boolean;
}

const ledgerAccountSchema = new Schema<LedgerAccountDoc>(
  {
    _id: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: LEDGER_ACCOUNT_TYPES, required: true },
    parentId: { type: String, index: true },
    description: String,
    bankAccountNumber: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

addRecordFields(ledgerAccountSchema);

export const LedgerAccount = model<LedgerAccountDoc>('AccountsLedgerAccount', ledgerAccountSchema, 'accounts_ledger_accounts');
