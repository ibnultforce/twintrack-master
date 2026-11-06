import { AuditLog, type AuditLogDoc } from '../models/auditLog.js';

export async function recordAudit(entry: Omit<AuditLogDoc, 'at'>): Promise<void> {
  await AuditLog.create({ ...entry, at: new Date() });
}
