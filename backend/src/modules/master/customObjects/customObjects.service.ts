import { z } from 'zod';
import { ApiError } from '../../../lib/errors.js';
import { fieldErrors } from '../../../lib/validation.js';
import type { Actor } from '../access/caller.js';
import { findAllProfiles } from '../accessProfiles/accessProfiles.repository.js';
import type { ModuleDoc } from '../models/module.js';
import { SHARING_MODELS, type ManifestResource } from '../moduleRegistry/manifest.js';
import { assertCustomObjectHasNoRecords, editModuleRules, saveRules } from '../moduleRegistry/permissionRules.service.js';

export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Every custom object offers the same actions, so profiles treat it like any other resource. */
const CUSTOM_OBJECT_ACTIONS: ManifestResource['actions'] = ['read', 'create', 'update', 'delete', 'share'];
const MAX_FIELDS = 50;
const MAX_OPTIONS = 50;

const fieldDefinitionSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'must be letters and numbers, starting with a lowercase letter'),
    label: z.string().trim().min(1, 'is required').max(100),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    /** The choices for a select field. */
    options: z.array(z.string().trim().min(1).max(100)).max(MAX_OPTIONS).optional(),
    /** Changes go in each record's history. */
    tracked: z.boolean().default(false),
    /** Hidden unless a profile gives access to the field. */
    protected: z.boolean().default(false),
  })
  .refine((field) => field.type !== 'select' || (field.options?.length ?? 0) > 0, { message: 'a select field needs options', path: ['options'] });

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

export const objectDefinitionSchema = z.strictObject({
  label: z.string().trim().min(1, 'is required').max(100),
  fields: z.array(fieldDefinitionSchema).min(1, 'needs at least one field').max(MAX_FIELDS),
  sharingModel: z.enum(SHARING_MODELS).default('private'),
});

export type ObjectDefinition = z.infer<typeof objectDefinitionSchema>;

const OBJECT_KEY = /^[a-z][a-zA-Z0-9]*$/;

/** A custom object as a module resource. Its tracked and protected fields come from the field definitions. */
function toResource(objectKey: string, definition: ObjectDefinition): ManifestResource {
  const keys = definition.fields.map((field) => field.key);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'fields', message: `field "${duplicates[0]}" is listed twice` }]);
  }
  return {
    key: objectKey,
    label: definition.label,
    actions: CUSTOM_OBJECT_ACTIONS,
    scoped: true,
    custom: true,
    fields: definition.fields,
    sharingModel: definition.sharingModel,
    trackedFields: definition.fields.filter((field) => field.tracked).map((field) => field.key),
    protectedFields: definition.fields.filter((field) => field.protected).map((field) => field.key),
  };
}

export function parseObjectDefinition(raw: unknown): ObjectDefinition {
  const parsed = objectDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', fieldErrors(parsed.error.issues));
  return parsed.data;
}

export function findCustomObject(module: ModuleDoc, objectKey: string): ManifestResource & { fields: FieldDefinition[] } {
  const resource = module.resources.find((candidate) => candidate.key === objectKey && candidate.custom === true);
  if (!resource) throw new ApiError(404, 'unknown_object', `${module.name} has no custom object called "${objectKey}".`);
  return resource as ManifestResource & { fields: FieldDefinition[] };
}

const objectTarget = (moduleKey: string, resource: Pick<ManifestResource, 'key' | 'label'>) => ({
  targetType: 'customObject',
  targetId: `${moduleKey}.${resource.key}`,
  targetName: resource.label,
});

/** Adds a custom object to a module. People reach its records once their profile gives its permissions. */
export function addCustomObject(actor: Actor, moduleKey: string, objectKey: string, definition: ObjectDefinition) {
  if (!OBJECT_KEY.test(objectKey)) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'key', message: 'must be letters and numbers, starting with a lowercase letter' }]);
  }
  return editModuleRules(moduleKey, async (module, session) => {
    if (module.resources.some((resource) => resource.key === objectKey)) {
      throw new ApiError(409, 'object_exists', `${module.name} already has a resource called "${objectKey}".`);
    }
    const resource = toResource(objectKey, definition);
    await saveRules(actor, module, { resources: [...module.resources, resource] }, { action: 'module.object_added', ...objectTarget(moduleKey, resource), after: definition }, session);
    return { module: moduleKey, object: resource };
  });
}

/** Replaces a custom object's label, fields and sharing model. Values of removed fields stay in records but are no longer shown. */
export function updateCustomObject(actor: Actor, moduleKey: string, objectKey: string, definition: ObjectDefinition) {
  return editModuleRules(moduleKey, async (module, session) => {
    const existing = findCustomObject(module, objectKey);
    const resource = toResource(objectKey, definition);
    const resources = module.resources.map((candidate) => (candidate.key === objectKey ? resource : candidate));
    await saveRules(actor, module, { resources }, {
      action: 'module.object_updated',
      ...objectTarget(moduleKey, resource),
      before: { label: existing.label, fields: existing.fields, sharingModel: existing.sharingModel },
      after: definition,
    }, session);
    return { module: moduleKey, object: resource };
  });
}

/** Removes a custom object with no records left, including none in the recycle bin. */
export function removeCustomObject(actor: Actor, moduleKey: string, objectKey: string) {
  return editModuleRules(moduleKey, async (module, session) => {
    const existing = findCustomObject(module, objectKey);
    await assertCustomObjectHasNoRecords(moduleKey, objectKey, session);
    const profiles = await findAllProfiles(session);
    const inUse = profiles.some((profile) => {
      const grants = Object.hasOwn(profile.grants, moduleKey) ? profile.grants[moduleKey] : undefined;
      return grants !== undefined && grants !== '*' && Object.hasOwn(grants, objectKey);
    });
    if (inUse) throw new ApiError(409, 'object_in_use', 'A profile still gives access to this object. Change it first.');
    await saveRules(actor, module, { resources: module.resources.filter((candidate) => candidate.key !== objectKey) }, {
      action: 'module.object_removed',
      ...objectTarget(moduleKey, existing),
    }, session);
    return { removed: true, module: moduleKey, object: objectKey };
  });
}
