import type { Query, Schema } from 'mongoose';

/** The fields every business record carries, whichever module it belongs to. */
export interface RecordFields {
  createdBy?: string;
  updatedBy?: string;
  /** Goes up by one on every change, so an edit made from an old copy can be refused. */
  version: number;
  /** Set when the record is in the recycle bin. Deleted records stay out of queries unless asked for. */
  deletedAt?: Date;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Pass this as a query option to include records in the recycle bin. */
export const WITH_DELETED = { withDeleted: true } as const;

/** Narrows a filter to records in the recycle bin. */
export const ONLY_DELETED = { deletedAt: { $exists: true } } as const;

const FILTERED_QUERIES = ['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany', 'distinct'] as const;

/**
 * Adds the standard record fields to a schema, and keeps deleted records out of every query that doesn't ask for them
 * with `WITH_DELETED` or a filter on `deletedAt`. Doing it here means no feature can forget to.
 */
export function addRecordFields(schema: Schema): void {
  schema.add({
    createdBy: String,
    updatedBy: String,
    version: { type: Number, default: 0 },
    deletedAt: { type: Date, index: true },
    deletedBy: String,
  });

  for (const operation of FILTERED_QUERIES) {
    schema.pre(operation, function hideDeletedRecords(this: Query<unknown, unknown>) {
      const options = this.getOptions() as { withDeleted?: boolean };
      if (options.withDeleted || Object.hasOwn(this.getFilter(), 'deletedAt')) return;
      this.where({ deletedAt: { $exists: false } });
    });
  }
}
