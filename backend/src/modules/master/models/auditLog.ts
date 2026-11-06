import { Schema, model } from 'mongoose';

export interface AuditLogDoc {
  at: Date;
  actorId?: string;
  actorName?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  module?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

const auditLogSchema = new Schema<AuditLogDoc>({
  at: { type: Date, required: true, default: Date.now, index: -1 },
  actorId: { type: String, index: true },
  actorName: String,
  action: { type: String, required: true, index: true },
  targetType: String,
  targetId: { type: String, index: true },
  targetName: String,
  module: String,
  reason: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  ip: String,
});

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
