import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { ModuleChange, type ModuleChangeDoc, type ModuleChangeSource } from '../models/moduleChange.js';
import type { ModuleChangeItem } from './moduleChanges.js';
import type { ModuleFiles } from './moduleFiles.js';
import { findModuleByKey } from './moduleRegistry.repository.js';

export const MODULE_CHANGE_STATUSES = ['pending', 'done'] as const;
export type ModuleChangeStatus = (typeof MODULE_CHANGE_STATUSES)[number];

export interface NewModuleChange {
  module: string;
  moduleName: string;
  source: ModuleChangeSource;
  versionBefore: string | null;
  versionAfter: string;
  items: ModuleChangeItem[];
}

function toModuleChange({ _id, ...change }: ModuleChangeDoc) {
  return { id: _id, ...change, status: (change.doneAt ? 'done' : 'pending') as ModuleChangeStatus };
}
export type ModuleChangeView = ReturnType<typeof toModuleChange>;

/** Saves what an import changed, in the import's transaction. An import that changed nothing records nothing. */
export async function recordModuleChange(actor: Actor, change: NewModuleChange, session: ClientSession): Promise<ModuleChangeView | null> {
  if (change.items.length === 0) return null;
  const { actorId, actorName } = actorFields(actor);
  const record: ModuleChangeDoc = { _id: randomUUID(), ...change, changedAt: new Date(), changedBy: actorId, changedByName: actorName };
  await ModuleChange.create([record], { session });
  return toModuleChange(record);
}

const statusFilter = (status?: ModuleChangeStatus) => (status === 'pending' ? { doneAt: { $exists: false } } : status === 'done' ? { doneAt: { $exists: true } } : {});

export async function listModuleChanges(key: string, query: PageRequest & { status?: ModuleChangeStatus }) {
  if (!(await findModuleByKey(key))) throw new ApiError(404, 'unknown_module', 'No such module.');
  const filter = { module: key, ...statusFilter(query.status) };
  const [changes, total, pending] = await Promise.all([
    ModuleChange.find(filter).sort({ changedAt: -1, _id: 1 }).skip(pageOffset(query)).limit(query.pageSize).lean(),
    ModuleChange.countDocuments(filter),
    ModuleChange.countDocuments({ module: key, ...statusFilter('pending') }),
  ]);
  return { changes: changes.map(toModuleChange), total, pending, page: query.page, pageSize: query.pageSize };
}

/** Marks one change as built: the code, docs and frontends now match it. */
export async function markModuleChangeDone(actor: Actor, key: string, changeId: string, moduleFiles: ModuleFiles) {
  const done = await runInTransaction(async (session) => {
    const { actorId, actorName } = actorFields(actor);
    const change = await ModuleChange.findOneAndUpdate(
      { _id: changeId, module: key, doneAt: { $exists: false } },
      { $set: { doneAt: new Date(), doneBy: actorId, doneByName: actorName } },
      { new: true, session },
    ).lean();
    if (!change) {
      const exists = await ModuleChange.exists({ _id: changeId, module: key }).session(session);
      throw exists ? new ApiError(409, 'already_done', 'That change is already marked done.') : new ApiError(404, 'unknown_change', 'No such change in this module.');
    }
    await recordAudit(
      { action: 'module.changeDone', ...actorFields(actor), targetType: 'module', targetId: key, targetName: change.moduleName, module: key, after: { changeId, items: change.items.length } },
      session,
    );
    return toModuleChange(change);
  });
  return { change: done, changeLog: await writeChangeLog(key, moduleFiles) };
}

const formatTime = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const KIND_LABELS = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

/** The pending changes as Markdown for manifests/changes/<key>.md, or null when nothing is pending. */
function renderChangeLog(moduleName: string, key: string, pending: ModuleChangeDoc[]): string | null {
  if (pending.length === 0) return null;
  const lines = [
    `# ${moduleName}: changes to build`,
    '',
    `Imports in the app changed the ${moduleName} manifest or schema. Each section lists what changed and where to work so the code and docs match. When a section is done, mark it done on Master's Modules screen (or \`POST /modules/${key}/changes/<id>/done\`); this file is rewritten from the database and drops it.`,
  ];
  for (const change of pending) {
    const version = change.versionBefore && change.versionBefore !== change.versionAfter ? `${change.versionBefore} → ${change.versionAfter}` : change.versionAfter;
    lines.push('', `## ${formatTime(change.changedAt)}: ${change.source} import by ${change.changedByName ?? 'unknown'} (version ${version})`, '', `Change id: \`${change._id}\``, '');
    for (const item of change.items) {
      lines.push(`- **${KIND_LABELS[item.kind]}** ${item.subject}${item.detail ? `: ${item.detail}` : ''}`);
      for (const place of item.where) lines.push(`  - ${place}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Rewrites the module's change file from the pending changes. Returns where it went, or null on a server that writes no files. */
export async function writeChangeLog(key: string, moduleFiles: ModuleFiles) {
  if (!moduleFiles.isEnabled) return null;
  const pending = await ModuleChange.find({ module: key, ...statusFilter('pending') }).sort({ changedAt: 1, _id: 1 }).lean();
  const moduleName = pending[0]?.moduleName ?? key;
  return moduleFiles.saveChangeLog(key, renderChangeLog(moduleName, key, pending));
}
