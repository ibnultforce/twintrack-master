import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { fieldErrors } from '../../../lib/validation.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { dataModelSchema, INSTRUCTIONS_KEY, type DataModel } from './manifest.js';
import type { ChangeLogReport, ModuleFiles, ModuleFilesReport } from './moduleFiles.js';
import { diffModule } from './moduleChanges.js';
import { recordModuleChange, writeChangeLog, type ModuleChangeView } from './moduleChanges.service.js';
import { findModuleByKey, saveModuleSchema } from './moduleRegistry.repository.js';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** The module's stored data model, or an empty outline naming the module when none has been loaded yet. */
export function describeModuleSchema(module: Pick<ModuleDoc, 'name' | 'schema'>): DataModel {
  return module.schema ?? { $schema: JSON_SCHEMA_DRAFT, title: `TwinTrack ${module.name} API`, $defs: {} };
}

/** Added to a downloaded schema so a person or Claude can change it correctly. An import drops it again. */
function editingInstructions(module: Pick<ModuleDoc, 'key' | 'name'>): string[] {
  return [
    `This is the data model of the TwinTrack ${module.name} module (key "${module.key}"), as JSON Schema (draft 2020-12). It describes the records the module's API returns, for frontend developers. It does not change the database, the API or anyone's access.`,
    'To change it: edit this file, then on Master\'s Modules screen choose the module, click "Import schema" and pick the file. The import replaces the whole data model, so keep every definition you still want.',
    'Each record is one entry in "$defs", named in PascalCase such as "Note". "$defs" is required and each entry must be an object. Everything else is kept exactly as written.',
    'In a definition: "properties" lists the fields, "required" lists fields that are always present, and "allOf": [{ "$ref": "#/$defs/RecordFields" }] includes shared fields. Refer to another definition with "$ref": "#/$defs/<Name>".',
    'Field types: "type" ("string", "integer", "number", "boolean", "object", "array"), "enum" for allowed values, "format" such as "date-time", "items" for list contents, and "description" for meaning. The Modules screen shows each field\'s type, whether it is always present and its field access.',
    'Mark field security with "x-fieldAccess": "controlled" (a profile\'s field access decides who sees or edits it) or "protected" (hidden unless a profile grants it). It must agree with the module manifest\'s recordFields and protectedFields, which are what the API enforces; change those in the manifest, not here.',
    'Describe the API as built: a field added here does not exist until the backend returns it. When the backend changes, update this file in the same change.',
    'A local development server also writes the import to manifests/<module key>.schema.json in the twintrack-master repo and rebuilds the pack of the module, so commit those files. A deployed server keeps the import in its database only, until the next deploy loads manifests/ again: there, make the same change in the repo.',
    'This "x-instructions" entry is removed when the file is imported, so leave it or delete it as you like.',
  ];
}

/** The schema as a downloadable file, with instructions for editing it first. */
export async function getModuleSchema(key: string): Promise<Record<string, unknown>> {
  const module = await findModuleByKey(key);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');
  const { $schema, ...rest } = describeModuleSchema(module);
  return { ...($schema && { $schema }), [INSTRUCTIONS_KEY]: editingInstructions(module), ...rest };
}

/** Replaces a module's data model without touching its resources or routes. */
export async function importModuleSchema(
  actor: Actor,
  key: string,
  rawSchema: unknown,
  moduleFiles: ModuleFiles,
): Promise<{ key: string; definitions: number; files: ModuleFilesReport; change: ModuleChangeView | null; changeLog: ChangeLogReport | null }> {
  const parsed = dataModelSchema.safeParse(rawSchema);
  if (!parsed.success) throw new ApiError(422, 'validation_failed', 'That schema is invalid.', fieldErrors(parsed.error.issues));
  const schema = parsed.data;

  const change = await runInTransaction(async (session) => {
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
    const items = diffModule(key, module, { schema });
    return recordModuleChange(actor, { module: key, moduleName: module.name, source: 'schema', versionBefore: module.version, versionAfter: module.version, items }, session);
  });
  const files = await moduleFiles.saveSchema(key, schema);
  const changeLog = change ? await writeChangeLog(key, moduleFiles) : null;
  return { key, definitions: Object.keys(schema.$defs).length, files, change, changeLog };
}
