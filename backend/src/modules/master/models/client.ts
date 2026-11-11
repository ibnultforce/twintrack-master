import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const CLIENT_STATUSES = ['active', 'inactive'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * A company TwinTrack works for. Shared by every module: projects are done for clients, and invoices and receipts are
 * billed to them. A client is made inactive, never deleted, so the records that name it stay whole.
 */
export interface ClientDoc extends RecordFields {
  _id: string;
  name: string;
  /** A short code, such as "ACME", used in invoice numbers. Stored in capitals and unique. */
  initials?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes?: string;
  status: ClientStatus;
}

const clientSchema = new Schema<ClientDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    initials: { type: String, uppercase: true, trim: true, unique: true, sparse: true },
    contactEmail: { type: String, lowercase: true, trim: true },
    contactPhone: String,
    address: String,
    notes: String,
    status: { type: String, enum: CLIENT_STATUSES, default: 'active', index: true },
  },
  { timestamps: true },
);

addRecordFields(clientSchema);

export const Client = model<ClientDoc>('Client', clientSchema);
