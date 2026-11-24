import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * Something the office keeps a count of, such as laptops in the store room or printer toner. Inventory tracks
 * quantities only: what it cost reaches the books through the bill it was bought on. Items are deactivated, never
 * deleted, so their movements stay whole. Goods are not returned to vendors through Accounts (decision 5).
 */
export interface InventoryItemDoc extends RecordFields {
  _id: string;
  name: string;
  /** The label on the item or shelf, such as TT-INV-0042. A text field. */
  assetTag?: string;
  category: string;
  /** How it is counted, such as pcs, boxes or reams. */
  unit: string;
  /** Below this, the item shows as running low. */
  reorderLevel?: number;
  isActive: boolean;
}

/** in: received. out: issued or used. adjust: a count correction, up or down. */
export const MOVEMENT_KINDS = ['in', 'out', 'adjust'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** One change to an item's stock. Never edited or deleted: a mistake is put right by an adjustment. */
export interface InventoryMovementDoc {
  _id: string;
  itemId: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: MovementKind;
  /** Positive for in and out; signed for adjust (negative lowers the count). Up to 3 decimals. */
  quantity: number;
  note?: string;
  /** Such as a bill number, or who the item was issued to. */
  reference?: string;
  createdBy: string;
  createdAt: Date;
}

const inventoryItemSchema = new Schema<InventoryItemDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    assetTag: String,
    category: { type: String, required: true },
    unit: { type: String, required: true },
    reorderLevel: Number,
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

addRecordFields(inventoryItemSchema);

export const InventoryItem = model<InventoryItemDoc>('AccountsInventoryItem', inventoryItemSchema, 'accounts_inventory_items');

const inventoryMovementSchema = new Schema<InventoryMovementDoc>(
  {
    _id: { type: String, required: true },
    itemId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    kind: { type: String, enum: MOVEMENT_KINDS, required: true },
    quantity: { type: Number, required: true },
    note: String,
    reference: String,
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
);

export const InventoryMovement = model<InventoryMovementDoc>('AccountsInventoryMovement', inventoryMovementSchema, 'accounts_inventory_movements');
