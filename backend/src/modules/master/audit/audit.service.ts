import type { PageRequest } from '../../../lib/query.js';
import { findAuditPage } from './audit.repository.js';

/** One page of the activity log, newest first. */
export async function listActivity(query: PageRequest & { actionPrefix?: string }) {
  const { entries, total } = await findAuditPage(query);
  return {
    total,
    entries: entries.map((entry) => ({
      id: String(entry._id),
      at: entry.at,
      actorId: entry.actorId,
      actorName: entry.actorName,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      targetName: entry.targetName,
      module: entry.module,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
      ip: entry.ip,
    })),
  };
}
