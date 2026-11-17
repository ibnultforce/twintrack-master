import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { fieldErrors } from '../../../lib/validation.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { dataModelSchema, type DataModel } from './manifest.js';
import { findModuleByKey, saveModuleSchema } from './moduleRegistry.repository.js';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** The module's stored data model, or an empty outline naming the module when none has been loaded yet. */
export function describeModuleSchema(module: Pick<ModuleDoc, 'name' | 'schema'>): DataModel {
  return module.schema ?? { $schema: JSON_SCHEMA_DRAFT, title: `TwinTrack ${module.name} API`, $defs: {} };
}

export async function getModuleSchema(key: string): Promise<DataModel> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  return describeModuleSchema(module);
}

/** Replaces a module's data model without touching its resources or routes. */
export async function importModuleSchema(actor: Actor, key: string, rawSchema: unknown): Promise<{ key: string; definitions: number }> {
  const parsed = dataModelSchema.safeParse(rawSchema);
  if (!parsed.success) throw new ApiError(422, 'validation_failed', 'That schema is invalid.', fieldErrors(parsed.error.issues));
  const schema = parsed.data;

  await runInTransaction(async (session) => {
    const module = await findModuleByKey(key, session);
    if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
    await saveModuleSchema(key, schema, session);
    await recordAudit(
      {
        action: 'module.schemaImported',
        ...actorFields(actor),
        targetType: 'module',
        targetId: key,
        targetName: module.name,
        module: key,
        before: { definitions: Object.keys(module.schema?.$defs ?? {}).length },
        after: { definitions: Object.keys(schema.$defs).length },
      },
      session,
    );
  });
  return { key, definitions: Object.keys(schema.$defs).length };
}
