import { runInTransaction } from '../db.js';
import { AccessProfile } from '../modules/master/models/accessProfile.js';
import { AuditLog } from '../modules/master/models/auditLog.js';
import { CustomRecord } from '../modules/master/models/customRecord.js';
import { Module } from '../modules/master/models/module.js';
import { RecordHistory } from '../modules/master/models/recordHistory.js';
import { RecordShare } from '../modules/master/models/recordShare.js';

export interface ModuleRename {
  fromKey: string;
  toKey: string;
  /** The module's new route prefix, such as /projects. Stored route paths under the old prefix move to it. */
  toBaseUrl: string;
}

export interface ModuleRenameResult {
  profiles: number;
  auditEntries: number;
  customRecords: number;
  historyEntries: number;
  shares: number;
}

const MODULE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Moves a path under the old prefix to the new one, leaving any other path as it is. */
function movePath(path: string, fromBaseUrl: string, toBaseUrl: string): string {
  if (path === fromBaseUrl) return toBaseUrl;
  return path.startsWith(`${fromBaseUrl}/`) ? `${toBaseUrl}${path.slice(fromBaseUrl.length)}` : path;
}

/**
 * Gives a module a new key everywhere the database stores it: the module itself, profile grants, and the module field
 * on audit entries, custom records, field history and shares. Super admins' route access changes move to the new
 * route prefix. It runs in one transaction, so a failure changes nothing. Load the renamed manifest afterwards with
 * seed:modules, which replaces the stored routes.
 */
export async function renameModule({ fromKey, toKey, toBaseUrl }: ModuleRename): Promise<ModuleRenameResult> {
  if (!MODULE_KEY_PATTERN.test(toKey)) throw new Error(`"${toKey}" isn't a valid module key.`);
  if (!toBaseUrl.startsWith('/')) throw new Error('The new base URL must start with /.');

  return runInTransaction(async (session) => {
    const stored = await Module.findOne({ key: fromKey }).session(session);
    if (!stored) throw new Error(`There is no module "${fromKey}" to rename.`);
    if (await Module.exists({ key: toKey }).session(session)) throw new Error(`A module "${toKey}" already exists.`);

    const fromBaseUrl = stored.baseUrl ?? `/${fromKey}`;
    stored.key = toKey;
    stored.baseUrl = toBaseUrl;
    for (const change of stored.routeAccess ?? []) change.path = movePath(change.path, fromBaseUrl, toBaseUrl);
    stored.markModified('routeAccess');
    await stored.save({ session });

    const grantsField = `grants.${fromKey}`;
    const profiles = await AccessProfile.updateMany({ [grantsField]: { $exists: true } }, { $rename: { [grantsField]: `grants.${toKey}` } }, { session });
    const auditEntries = await AuditLog.updateMany({ module: fromKey }, { $set: { module: toKey } }, { session });
    const customRecords = await CustomRecord.updateMany({ module: fromKey }, { $set: { module: toKey } }, { session });
    const historyEntries = await RecordHistory.updateMany({ module: fromKey }, { $set: { module: toKey } }, { session });
    const shares = await RecordShare.updateMany({ module: fromKey }, { $set: { module: toKey } }, { session });

    return {
      profiles: profiles.modifiedCount,
      auditEntries: auditEntries.modifiedCount,
      customRecords: customRecords.modifiedCount,
      historyEntries: historyEntries.modifiedCount,
      shares: shares.modifiedCount,
    };
  });
}
