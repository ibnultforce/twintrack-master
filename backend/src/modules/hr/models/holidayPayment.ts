import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const HOLIDAY_PAYMENT_STATUSES = ['unpaid', 'paid'] as const;
export const HOLIDAY_PAYMENT_METHODS = ['bank', 'cash'] as const;

/** Extra pay for working on a public holiday, agreed by HR and then paid. */
export interface HolidayPaymentDoc extends RecordFields {
  _id: string;
  employeeId: string;
  holidayDate: Date;
  /** The holiday's name, such as Eid ul-Fitr. */
  title: string;
  amount: number;
  currency: string;
  status: (typeof HOLIDAY_PAYMENT_STATUSES)[number];
  paidOn?: Date;
  paymentMethod?: (typeof HOLIDAY_PAYMENT_METHODS)[number];
}

const holidayPaymentSchema = new Schema<HolidayPaymentDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    holidayDate: { type: Date, required: true },
    title: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    status: { type: String, enum: HOLIDAY_PAYMENT_STATUSES, default: 'unpaid' },
    paidOn: Date,
    paymentMethod: { type: String, enum: HOLIDAY_PAYMENT_METHODS },
  },
  { timestamps: true },
);

holidayPaymentSchema.index({ employeeId: 1, holidayDate: -1 });
addRecordFields(holidayPaymentSchema);

export const HolidayPayment = model<HolidayPaymentDoc>('HolidayPayment', holidayPaymentSchema);
