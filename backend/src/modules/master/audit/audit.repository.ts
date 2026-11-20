import type { ClientSession } from 'mongoose';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { AuditLog, type AuditLogDoc } from '../models/auditLog.js';

export async function recordAudit(entry: Omit<AuditLogDoc, 'at'>, session?: ClientSession): Promise<void> {
  await AuditLog.create([{ ...entry, at: new Date() }], { session });
}

export interface AuditFilter {
  actionPrefix?: string;
  /** Only entries a module wrote, such as "accounts". */
  module?: string;
}

export async function findAuditPage({ actionPrefix, module, ...page }: PageRequest & AuditFilter) {
  const filter = {
    ...(actionPrefix && { action: { $regex: `^${escapeRegex(actionPrefix)}` } }),
    ...(module && { module }),
  };
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { entries, total };
}
