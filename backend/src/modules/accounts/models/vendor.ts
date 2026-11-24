import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const VENDOR_CATEGORIES = ['rent', 'cloud', 'utilities', 'equipment', 'food_and_events', 'other'] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

/** Someone the company buys from. Deactivated, never deleted, so the bills that name a vendor stay whole. */
export interface VendorDoc extends RecordFields {
  _id: string;
  name: string;
  category: VendorCategory;
  /** Tax deducted at source from each of their bills, in basis points: 500 is 5%. From the tax advisor's rates. */
  tdsBasisPoints: number;
  contactEmail?: string;
  contactPhone?: string;
  isActive: boolean;
}

const vendorSchema = new Schema<VendorDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: VENDOR_CATEGORIES, required: true },
    tdsBasisPoints: { type: Number, required: true, default: 0 },
    contactEmail: String,
    contactPhone: String,
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

addRecordFields(vendorSchema);

export const Vendor = model<VendorDoc>('AccountsVendor', vendorSchema, 'accounts_vendors');
