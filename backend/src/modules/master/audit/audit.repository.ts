import type { ClientSession } from 'mongoose';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { AuditLog, type AuditLogDoc } from '../models/auditLog.js';

export async function recordAudit(entry: Omit<AuditLogDoc, 'at'>, session?: ClientSession): Promise<void> {
  await AuditLog.create([{ ...entry, at: new Date() }], { session });
}

export async function findAuditPage({ actionPrefix, ...page }: PageRequest & { actionPrefix?: string }) {
  const filter = actionPrefix ? { action: { $regex: `^${escapeRegex(actionPrefix)}` } } : {};
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { entries, total };
}
