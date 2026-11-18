import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const PAY_METHODS = ['bank_transfer', 'cash', 'mobile_banking'] as const;

/**
 * How a person's pay is made up and paid. The total and its approval stay on the Salary record; this splits it into
 * parts and says where the money goes. Monthly incentives are a Project management setting, not part of this.
 */
export interface PayrollProfileDoc extends RecordFields {
  _id: string;
  employeeId: string;
  currency: string;

  // Parts of the salary
  basicAmount?: number;
  houseRentAmount?: number;
  medicalAmount?: number;
  conveyanceAmount?: number;
  otherAllowanceAmount?: number;
  /** A missing amount on an allowance that is turned on means it hasn't been set yet. */
  foodAllowanceEnabled: boolean;
  foodAllowanceAmount?: number;
  transportAllowanceEnabled: boolean;
  transportAllowanceAmount?: number;
  mobileAllowanceEnabled: boolean;
  mobileAllowanceAmount?: number;

  // Where pay goes
  payMethod?: (typeof PAY_METHODS)[number];
  bankName?: string;
  bankBranch?: string;
  /** Encrypted with ENCRYPTION_KEY. */
  bankAccountNumberEncrypted?: string;
  bankRoutingNumberEncrypted?: string;
  mobileBankingNumber?: string;

  // Benefits
  providentFundEnrolled: boolean;
  providentFundPercent?: number;
  gratuityEligible: boolean;
  costCenter?: string;
}

const payrollProfileSchema = new Schema<PayrollProfileDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true, unique: true },
    currency: { type: String, required: true },

    basicAmount: { type: Number, min: 0 },
    houseRentAmount: { type: Number, min: 0 },
    medicalAmount: { type: Number, min: 0 },
    conveyanceAmount: { type: Number, min: 0 },
    otherAllowanceAmount: { type: Number, min: 0 },
    foodAllowanceEnabled: { type: Boolean, default: false },
    foodAllowanceAmount: { type: Number, min: 0 },
    transportAllowanceEnabled: { type: Boolean, default: false },
    transportAllowanceAmount: { type: Number, min: 0 },
    mobileAllowanceEnabled: { type: Boolean, default: false },
    mobileAllowanceAmount: { type: Number, min: 0 },

    payMethod: { type: String, enum: PAY_METHODS },
    bankName: String,
    bankBranch: String,
    bankAccountNumberEncrypted: String,
    bankRoutingNumberEncrypted: String,
    mobileBankingNumber: String,

    providentFundEnrolled: { type: Boolean, default: false },
    providentFundPercent: { type: Number, min: 0, max: 100 },
    gratuityEligible: { type: Boolean, default: false },
    costCenter: String,
  },
  { timestamps: true },
);

addRecordFields(payrollProfileSchema);

export const PayrollProfile = model<PayrollProfileDoc>('PayrollProfile', payrollProfileSchema);
