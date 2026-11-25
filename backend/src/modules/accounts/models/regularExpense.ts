import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** What a regular expense is for, as the Accounts specification lists them. Rent is shown on the Office rent screen. */
export const REGULAR_EXPENSE_CATEGORIES = ['rent', 'cloud_software', 'utilities', 'office_services', 'food_events', 'travel', 'insurance', 'government_fees'] as const;
export type RegularExpenseCategory = (typeof REGULAR_EXPENSE_CATEGORIES)[number];

export const REGULAR_EXPENSE_FREQUENCIES = ['monthly', 'yearly'] as const;
export type RegularExpenseFrequency = (typeof REGULAR_EXPENSE_FREQUENCIES)[number];

/**
 * A cost that comes back every month or year, such as office rent or a software subscription. It never writes to the
 * ledger itself: each period it makes a draft bill (decision 4), which someone approves and pays like any bill.
 */
export interface RegularExpenseDoc extends RecordFields {
  _id: string;
  name: string;
  category: RegularExpenseCategory;
  vendorId: string;
  /** Copied from the vendor when saved. */
  vendorName: string;
  /** The expense account each bill is charged to, such as 5300 Office rent. */
  accountId: string;
  frequency: RegularExpenseFrequency;
  /** Paisa per period, before VAT. */
  amount: number;
  /** A Settings tax rate's code, charged as VAT on each bill. */
  vatCode?: string;
  /** The day of the month each bill is dated and due, 1 to 28, so every month has it. */
  dayOfMonth: number;
  /** The first period, YYYY-MM. A yearly expense falls in this month every year. */
  startMonth: string;
  /** The last period, YYYY-MM; none means it carries on. */
  endMonth?: string;
  isActive: boolean;
}

const regularExpenseSchema = new Schema<RegularExpenseDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, enum: REGULAR_EXPENSE_CATEGORIES, required: true },
    vendorId: { type: String, required: true },
    vendorName: { type: String, required: true },
    accountId: { type: String, required: true },
    frequency: { type: String, enum: REGULAR_EXPENSE_FREQUENCIES, required: true },
    amount: { type: Number, required: true },
    vatCode: String,
    dayOfMonth: { type: Number, required: true },
    startMonth: { type: String, required: true },
    endMonth: String,
    isActive: { type: Boolean, required: true },
  },
  { timestamps: true },
);

addRecordFields(regularExpenseSchema);

export const RegularExpense = model<RegularExpenseDoc>('AccountsRegularExpense', regularExpenseSchema, 'accounts_regular_expenses');
