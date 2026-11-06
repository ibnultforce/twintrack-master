import { Schema, model } from 'mongoose';

export const SALARY_STATUSES = ['pending', 'approved'] as const;

/** One person's salary from a given date. Changing the amount sends it back to pending, so it's approved again. */
export interface SalaryDoc {
  _id: string;
  employeeId: string;
  amount: number;
  currency: string;
  effectiveFrom: Date;
  status: (typeof SALARY_STATUSES)[number];
  approvedBy?: string;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const salarySchema = new Schema<SalaryDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    effectiveFrom: { type: Date, required: true },
    status: { type: String, enum: SALARY_STATUSES, default: 'pending' },
    approvedBy: String,
    approvedAt: Date,
  },
  { timestamps: true },
);

export const Salary = model<SalaryDoc>('Salary', salarySchema);
