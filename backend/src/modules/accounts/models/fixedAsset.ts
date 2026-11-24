import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

export const ASSET_CATEGORIES = ['computers', 'furniture', 'office_equipment', 'vehicles', 'software', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/**
 * Something the company owns and uses for years, such as a laptop. Its purchase reaches the books through a bill
 * charged to 1600 Fixed assets; this register adds what the books need to spread its cost: depreciated straight-line,
 * month by month, from the purchase month. Depreciation itself is recorded by a month's depreciation run, and what has
 * been depreciated is read back from those recorded vouchers, never stored here.
 */
export interface FixedAssetDoc extends RecordFields {
  _id: string;
  /** FA-0001 and so on. Depreciation lines name the asset by it. */
  number: string;
  name: string;
  /** The label stuck on the item, such as TT-LAP-014. */
  assetTag?: string;
  category: AssetCategory;
  /** YYYY-MM-DD. Depreciation starts in this month. */
  purchaseDate: string;
  /** Paisa. */
  cost: number;
  /** Paisa: what it should still be worth at the end of its life. */
  salvageValue: number;
  usefulLifeMonths: number;
  /** The bill it was bought on, if any. */
  billId?: string;
  isActive: boolean;
}

const fixedAssetSchema = new Schema<FixedAssetDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    assetTag: String,
    category: { type: String, enum: ASSET_CATEGORIES, required: true },
    purchaseDate: { type: String, required: true },
    cost: { type: Number, required: true },
    salvageValue: { type: Number, required: true, default: 0 },
    usefulLifeMonths: { type: Number, required: true },
    billId: String,
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

addRecordFields(fixedAssetSchema);

export const FixedAsset = model<FixedAssetDoc>('AccountsFixedAsset', fixedAssetSchema, 'accounts_fixed_assets');
