import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * draft: being written; may be edited.
 * submitted: waiting for someone other than its maker.
 * issued: approved, and recorded as money the client owes (receivable against service income).
 * cancelled: a draft given up, or an issued invoice reversed in the ledger. Its tasks can be billed again.
 * Paid and overdue are worked out from the receipts linked to it and its due date, never stored.
 */
export const INVOICE_STATUSES = ['draft', 'submitted', 'issued', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** One thing billed. A line made from a task keeps the task, which is marked invoiced so it is never billed twice. */
export interface InvoiceLine {
  description: string;
  /** In the invoice's currency, minor units (cents or paisa). */
  amount: number;
  taskId?: string;
  /** The task's estimated hours, billed at the client's rate. */
  hours?: number;
  milestone?: string;
}

export interface InvoiceDoc extends RecordFields {
  _id: string;
  /** INV-0001 and so on. */
  number: string;
  clientId: string;
  /** Copied from the client when the invoice is made, so a later rename doesn't change it. */
  clientName: string;
  currency: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  dueDate: string;
  lines: InvoiceLine[];
  /** The sum of the lines, in the invoice's currency. */
  total: number;
  /** Paisa per unit of the currency on the issue date; 100 for taka. Set when it is issued. */
  exchangeRate?: number;
  /** The total in paisa at that rate: what the books record as owed. Set when it is issued. */
  totalInTaka?: number;
  status: InvoiceStatus;
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

const lineSchema = new Schema<InvoiceLine>(
  { description: { type: String, required: true }, amount: { type: Number, required: true }, taskId: String, hours: Number, milestone: String },
  { _id: false },
);

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    clientId: { type: String, required: true, index: true },
    clientName: { type: String, required: true },
    currency: { type: String, required: true },
    issueDate: { type: String, required: true },
    dueDate: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    total: { type: Number, required: true },
    exchangeRate: Number,
    totalInTaka: Number,
    status: { type: String, enum: INVOICE_STATUSES, required: true, index: true },
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

addRecordFields(invoiceSchema);

export const Invoice = model<InvoiceDoc>('AccountsInvoice', invoiceSchema, 'accounts_invoices');
