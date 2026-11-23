import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';
import type { LedgerLine } from './ledgerEntry.js';

/**
 * waiting: someone other than the requester has to approve or reject it.
 * applied: approved; the record's old ledger entry was reversed and the corrected one recorded.
 * rejected: turned down with a note; nothing changed.
 */
export const UPDATE_REQUEST_STATUSES = ['waiting', 'applied', 'rejected'] as const;
export type UpdateRequestStatus = (typeof UPDATE_REQUEST_STATUSES)[number];

/** The record types an update request can correct. Bills and payroll runs join when they are built. */
export const CORRECTABLE_RECORD_TYPES = ['journalVoucher'] as const;
export type CorrectableRecordType = (typeof CORRECTABLE_RECORD_TYPES)[number];

/** A voucher's money details: what the request found, or what it asks for. */
export interface VoucherContent {
  voucherDate: string;
  memo: string;
  lines: LedgerLine[];
  /** Whole paisa: the sum of the debits, which equals the sum of the credits. */
  total: number;
}

/**
 * A request to correct a recorded record, which is never edited directly. Applying it reverses the record's ledger
 * entry and records the corrected one, in one transaction, so the ledger keeps both the mistake and its fix.
 */
export interface UpdateRequestDoc extends RecordFields {
  _id: string;
  /** UR-0001 and so on, handed out once and never reused. */
  number: string;
  recordType: CorrectableRecordType;
  recordId: string;
  /** The record's own number, such as JV-0004, kept so lists need no lookup. */
  recordNumber: string;
  /** Why the record is wrong, in the requester's words. */
  reason: string;
  /** The record as it was when the request was made. */
  before: VoucherContent;
  /** The record as it will be once the request is applied. */
  after: VoucherContent;
  status: UpdateRequestStatus;
  decidedBy?: string;
  decidedAt?: Date;
  /** Why it was rejected, shown to the requester. */
  rejectionNote?: string;
  /** Set when applied: the reversal of the old entry, and the corrected entry. */
  reversalEntryId?: string;
  correctedEntryId?: string;
}

const lineSchema = new Schema<LedgerLine>(
  { accountId: { type: String, required: true }, debit: { type: Number, required: true }, credit: { type: Number, required: true }, memo: String },
  { _id: false },
);

const contentSchema = new Schema<VoucherContent>(
  {
    voucherDate: { type: String, required: true },
    memo: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    total: { type: Number, required: true },
  },
  { _id: false },
);

const updateRequestSchema = new Schema<UpdateRequestDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    recordType: { type: String, enum: CORRECTABLE_RECORD_TYPES, required: true },
    recordId: { type: String, required: true },
    recordNumber: { type: String, required: true },
    reason: { type: String, required: true },
    before: { type: contentSchema, required: true },
    after: { type: contentSchema, required: true },
    status: { type: String, enum: UPDATE_REQUEST_STATUSES, required: true, index: true },
    decidedBy: String,
    decidedAt: Date,
    rejectionNote: String,
    reversalEntryId: String,
    correctedEntryId: String,
  },
  { timestamps: true },
);

// One waiting request per record, so two corrections can never both be applied on top of the same entry.
updateRequestSchema.index({ recordType: 1, recordId: 1 }, { unique: true, partialFilterExpression: { status: 'waiting' } });

addRecordFields(updateRequestSchema);

export const UpdateRequest = model<UpdateRequestDoc>('AccountsUpdateRequest', updateRequestSchema, 'accounts_update_requests');
