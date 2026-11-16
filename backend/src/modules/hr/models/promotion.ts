import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/**
 * A change in someone's job level. Org roles are Master's job levels, so a promotion names the roles. Titles are kept
 * as written at the time too, because a role can be renamed or removed later and the history must still read right.
 */
export interface PromotionDoc extends RecordFields {
  _id: string;
  employeeId: string;
  effectiveOn: Date;
  previousOrgRoleId?: string;
  newOrgRoleId?: string;
  previousTitle?: string;
  newTitle?: string;
  notes?: string;
}

const promotionSchema = new Schema<PromotionDoc>(
  {
    _id: { type: String, required: true },
    employeeId: { type: String, required: true },
    effectiveOn: { type: Date, required: true },
    previousOrgRoleId: String,
    newOrgRoleId: String,
    previousTitle: String,
    newTitle: String,
    notes: String,
  },
  { timestamps: true },
);

promotionSchema.index({ employeeId: 1, effectiveOn: -1 });
addRecordFields(promotionSchema);

export const Promotion = model<PromotionDoc>('Promotion', promotionSchema);
