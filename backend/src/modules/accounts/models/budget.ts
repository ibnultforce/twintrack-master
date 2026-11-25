import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** What may be spent on one expense account in the year. */
export interface BudgetLine {
  accountId: string;
  /** Paisa for the whole financial year. */
  amount: number;
}

/** A financial year's budget, July to June. One per year; its id is `fy_2026` for July 2026 to June 2027. */
export interface BudgetDoc extends RecordFields {
  _id: string;
  /** The calendar year it starts in. */
  year: number;
  lines: BudgetLine[];
}

const budgetSchema = new Schema<BudgetDoc>(
  {
    _id: { type: String, required: true },
    year: { type: Number, required: true, unique: true },
    lines: {
      type: [new Schema<BudgetLine>({ accountId: { type: String, required: true }, amount: { type: Number, required: true } }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true },
);

addRecordFields(budgetSchema);

export const Budget = model<BudgetDoc>('AccountsBudget', budgetSchema, 'accounts_budgets');
