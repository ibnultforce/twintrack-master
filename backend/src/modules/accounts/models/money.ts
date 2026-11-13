import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';
import { CURRENCIES, TRANSACTION_METHODS, type Currency, type TransactionMethod } from '../accountsModule.js';

/**
 * Money owed and money moved. A bill is what a vendor asks for; a payment is money out of a bank account; a receipt is
 * money in. Posted payments and receipts are never edited or deleted: a mistake is corrected by a linked reversal,
 * which moves the money back on its own date, so a bank account's history always adds up.
 */

export const BILL_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'partially_paid', 'paid', 'reversed'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export interface BillDoc extends RecordFields {
  _id: string;
  /** The vendor's own number for it, when they gave one. */
  billNumber?: string;
  vendorId: string;
  categoryId?: string;
  /** A Tasks project the spending was for. */
  projectId?: string;
  department?: string;
  businessDate: Date;
  dueDate?: Date;
  currency: Currency;
  amount: number;
  taxCode?: string;
  notes?: string;
  status: BillStatus;
  decidedBy?: string;
  decidedAt?: Date;
  rejectionReason?: string;
  reversedBy?: string;
  reversedAt?: Date;
  reversalReason?: string;
}

const billSchema = new Schema<BillDoc>(
  {
    _id: { type: String, required: true },
    billNumber: String,
    vendorId: { type: String, required: true, index: true },
    categoryId: { type: String, index: true },
    projectId: { type: String, index: true },
    department: String,
    businessDate: { type: Date, required: true },
    dueDate: Date,
    currency: { type: String, enum: CURRENCIES, required: true },
    amount: { type: Number, required: true, min: 0 },
    taxCode: String,
    notes: String,
    status: { type: String, enum: BILL_STATUSES, default: 'draft', index: true },
    decidedBy: String,
    decidedAt: Date,
    rejectionReason: String,
    reversedBy: String,
    reversedAt: Date,
    reversalReason: String,
  },
  { timestamps: true },
);
addRecordFields(billSchema);
export const Bill = model<BillDoc>('AccountsBill', billSchema, 'accounts_bills');

export const PAYEE_TYPES = ['vendor', 'employee', 'other'] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

export interface PaymentDoc extends RecordFields {
  _id: string;
  bankAccountId: string;
  billId?: string;
  categoryId?: string;
  projectId?: string;
  department?: string;
  payeeType: PayeeType;
  payeeVendorId?: string;
  payeeUserId?: string;
  payeeName?: string;
  /** Always positive. A reversal carries the same amount and moves it back. */
  amount: number;
  /** The bank account's currency. */
  currency: Currency;
  paymentDate: Date;
  method: TransactionMethod;
  reference?: string;
  notes?: string;
  /** Set on a reversal: the payment it cancels. */
  reversesId?: string;
  /** Set on a payment that has been reversed: the reversal that cancels it. */
  reversalId?: string;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    _id: { type: String, required: true },
    bankAccountId: { type: String, required: true, index: true },
    billId: { type: String, index: true },
    categoryId: String,
    projectId: String,
    department: String,
    payeeType: { type: String, enum: PAYEE_TYPES, required: true },
    payeeVendorId: { type: String, index: true },
    payeeUserId: { type: String, index: true },
    payeeName: String,
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
    paymentDate: { type: Date, required: true },
    method: { type: String, enum: TRANSACTION_METHODS, required: true },
    reference: String,
    notes: String,
    // Unique, so a payment can be reversed once even when two people try at the same moment.
    reversesId: { type: String, unique: true, sparse: true },
    reversalId: String,
  },
  { timestamps: true },
);
addRecordFields(paymentSchema);
export const Payment = model<PaymentDoc>('AccountsPayment', paymentSchema, 'accounts_payments');

/** Part of a receipt counted against one invoice. */
export interface ReceiptAllocation {
  _id: string;
  invoiceId: string;
  amount: number;
  createdBy: string;
  createdAt: Date;
}

export interface ReceiptDoc extends RecordFields {
  _id: string;
  bankAccountId: string;
  clientId?: string;
  /** What the client paid, before the bank's fee. */
  amount: number;
  /** Kept apart from the amount, so both what the client paid and what reached the bank can be read. */
  bankFee: number;
  currency: Currency;
  receivedDate: Date;
  method: TransactionMethod;
  reference?: string;
  notes?: string;
  allocations: ReceiptAllocation[];
  reversesId?: string;
  reversalId?: string;
}

const allocationSchema = new Schema<ReceiptAllocation>(
  {
    _id: { type: String, required: true },
    invoiceId: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const receiptSchema = new Schema<ReceiptDoc>(
  {
    _id: { type: String, required: true },
    bankAccountId: { type: String, required: true, index: true },
    clientId: { type: String, index: true },
    amount: { type: Number, required: true, min: 0 },
    bankFee: { type: Number, default: 0, min: 0 },
    currency: { type: String, enum: CURRENCIES, required: true },
    receivedDate: { type: Date, required: true },
    method: { type: String, enum: TRANSACTION_METHODS, required: true },
    reference: String,
    notes: String,
    allocations: { type: [allocationSchema], default: [] },
    reversesId: { type: String, unique: true, sparse: true },
    reversalId: String,
  },
  { timestamps: true },
);
receiptSchema.index({ 'allocations.invoiceId': 1 });
addRecordFields(receiptSchema);
export const Receipt = model<ReceiptDoc>('AccountsReceipt', receiptSchema, 'accounts_receipts');
