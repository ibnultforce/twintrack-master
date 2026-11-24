import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * How Accounts bills one Master client. Its id is the client's id, so there is at most one per client. A client with
 * none is billed on the defaults: Net 30, the default currency from Settings, and no rate until someone sets one.
 */
export interface ClientAccountDoc extends RecordFields {
  _id: string;
  /** Days from an invoice's issue date to its due date. */
  termsDays: number;
  /** The currency the client is billed in: the home currency or one listed in Settings. */
  currency?: string;
  /** Per hour of task estimate, in the currency's minor units: 4500 is $45.00 an hour. */
  hourlyRate?: number;
}

export const DEFAULT_TERMS_DAYS = 30;

const clientAccountSchema = new Schema<ClientAccountDoc>(
  {
    _id: { type: String, required: true },
    termsDays: { type: Number, required: true, default: DEFAULT_TERMS_DAYS },
    currency: String,
    hourlyRate: Number,
  },
  { timestamps: true },
);

addRecordFields(clientAccountSchema);

export const ClientAccount = model<ClientAccountDoc>('AccountsClientAccount', clientAccountSchema, 'accounts_client_accounts');
