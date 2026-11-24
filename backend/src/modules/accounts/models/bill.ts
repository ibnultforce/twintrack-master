import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * draft: being written; may be edited.
 * submitted: waiting for someone other than its maker.
 * recorded: approved, and recorded as owed to the vendor (expense against accounts payable and tax payable).
 * cancelled: a draft given up, or a recorded bill reversed in the ledger.
 * Paid and overdue are worked out from the payments linked to it and its due date, never stored.
 */
export const BILL_STATUSES = ['draft', 'submitted', 'recorded', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** One thing bought. Its amount is quantity × unit price, rounded to the paisa. */
export interface BillLine {
  description: string;
  /** The expense or asset account it is charged to. */
  accountId: string;
  quantity: number;
  /** Paisa. */
  unitPrice: number;
  /** Paisa. */
  amount: number;
}

/** A vendor's bill. Bills are kept in taka. */
export interface BillDoc extends RecordFields {
  _id: string;
  /** B-0001 and so on. */
  number: string;
  vendorId: string;
  /** Copied from the vendor when the bill is saved. */
  vendorName: string;
  /** The vendor's own invoice number. */
  vendorReference?: string;
  /** YYYY-MM-DD. */
  billDate: string;
  dueDate: string;
  lines: BillLine[];
  /** Paisa: the sum of the lines. */
  amount: number;
  /** The vendor's TDS rate when the bill was last saved, in basis points. */
  tdsBasisPoints: number;
  /** Paisa withheld and owed to the tax authority instead of the vendor. */
  tds: number;
  /** Paisa owed to the vendor: amount minus TDS. */
  netPayable: number;
  status: BillStatus;
  submittedBy?: string;
  submittedAt?: Date;
  returnNote?: string;
  approvedBy?: string;
  approvedAt?: Date;
  ledgerEntryId?: string;
  cancelledBy?: string;
  cancelledAt?: Date;
  reversalEntryId?: string;
}

const lineSchema = new Schema<BillLine>(
  {
    description: { type: String, required: true },
    accountId: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

const billSchema = new Schema<BillDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    vendorId: { type: String, required: true, index: true },
    vendorName: { type: String, required: true },
    vendorReference: String,
    billDate: { type: String, required: true },
    dueDate: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    amount: { type: Number, required: true },
    tdsBasisPoints: { type: Number, required: true },
    tds: { type: Number, required: true },
    netPayable: { type: Number, required: true },
    status: { type: String, enum: BILL_STATUSES, required: true, index: true },
    submittedBy: String,
    submittedAt: Date,
    returnNote: String,
    approvedBy: String,
    approvedAt: Date,
    ledgerEntryId: String,
    cancelledBy: String,
    cancelledAt: Date,
    reversalEntryId: String,
  },
  { timestamps: true },
);

addRecordFields(billSchema);

export const Bill = model<BillDoc>('AccountsBill', billSchema, 'accounts_bills');
