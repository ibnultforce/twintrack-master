import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';
import { CURRENCIES, type Currency } from '../accountsModule.js';

export const INVOICE_STATUSES = ['draft', 'sent', 'paid'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * How an invoice chose its tasks: work finished in the period, for all of a client's projects, or every task logged in
 * the period for chosen projects, whatever its status, which can also take custom lines.
 */
export const INVOICE_BASES = ['completed', 'logged'] as const;
export type InvoiceBasis = (typeof INVOICE_BASES)[number];

/** One line as billed. It's a snapshot: later changes to the task don't change the invoice. */
export interface InvoiceLine {
  _id: string;
  projectId: string;
  /** Missing on a custom line, which was never a task. */
  taskId?: string;
  taskNumber?: string;
  description: string;
  date: Date;
  hours: number;
  billable: boolean;
  /** Billable hours times the rate. Zero when not billable. */
  amount: number;
}

export interface InvoiceProjectTotal {
  projectId: string;
  projectName: string;
  totalHours: number;
  billableHours: number;
  amount: number;
}

export interface InvoiceDoc extends RecordFields {
  _id: string;
  /** Such as INV-AC-02-10-26, unique. */
  invoiceNumber: string;
  clientId: string;
  /** As it was when invoiced. */
  clientName: string;
  periodStart: Date;
  periodEnd: Date;
  basis: InvoiceBasis;
  currency: Currency;
  hourlyRate: number;
  totalHours: number;
  billableHours: number;
  amount: number;
  status: InvoiceStatus;
  projects: InvoiceProjectTotal[];
  lines: InvoiceLine[];
  /** Printed at the end of the document, as plain paragraphs. */
  additionalNotes?: string;
  /** Where the generated Word document is stored. */
  documentKey?: string;
  /** Goes up each time the document is made again, so people can tell copies apart. */
  documentVersion: number;
  emailedAt?: Date;
  emailedTo?: string;
}

const lineSchema = new Schema<InvoiceLine>(
  {
    _id: { type: String, required: true },
    projectId: { type: String, required: true },
    taskId: String,
    taskNumber: String,
    description: { type: String, required: true },
    date: { type: Date, required: true },
    hours: { type: Number, required: true, min: 0 },
    billable: { type: Boolean, required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const projectTotalSchema = new Schema<InvoiceProjectTotal>(
  {
    projectId: { type: String, required: true },
    projectName: { type: String, required: true },
    totalHours: { type: Number, required: true },
    billableHours: { type: Number, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    _id: { type: String, required: true },
    invoiceNumber: { type: String, required: true, unique: true },
    clientId: { type: String, required: true, index: true },
    clientName: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    basis: { type: String, enum: INVOICE_BASES, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    hourlyRate: { type: Number, required: true, min: 0 },
    totalHours: { type: Number, required: true },
    billableHours: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft', index: true },
    projects: { type: [projectTotalSchema], default: [] },
    lines: { type: [lineSchema], default: [] },
    additionalNotes: String,
    documentKey: String,
    documentVersion: { type: Number, default: 0 },
    emailedAt: Date,
    emailedTo: String,
  },
  { timestamps: true },
);
addRecordFields(invoiceSchema);
export const Invoice = model<InvoiceDoc>('AccountsInvoice', invoiceSchema, 'accounts_invoices');
