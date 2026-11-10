import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import { checkGrants, grantsSchema, MODULE_KEY, type Manifest } from '../moduleRegistry/manifest.js';
import type { NewAccessProfileRecord } from './accessProfiles.repository.js';

const profileRowSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be letters, numbers, hyphens and underscores'),
  name: z.string().trim().min(1, 'is required'),
  description: z.string().trim().min(1).optional(),
  grants: z.record(z.string().regex(MODULE_KEY, 'must be a module key'), grantsSchema),
});

/** Checks a whole profiles file against the manifests loaded with it. Any problem rejects the file. */
export function validateProfilesFile(raw: unknown, manifests: Manifest[]): Validated<NewAccessProfileRecord[]> {
  const file = asRecord(raw);
  if (file.type !== 'profiles' || !Array.isArray(file.profiles)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "profiles", "profiles": [...] }' }] };
  }

  const records: NewAccessProfileRecord[] = [];
  const errors: FieldError[] = [];
  const seenIds = new Set<string>();
  file.profiles.forEach((row: unknown, index: number) => {
    const parsed = profileRowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(...fieldErrors(parsed.error.issues, `profiles.${index}`));
      return;
    }
    const { id, name, description, grants } = parsed.data;
    if (seenIds.has(id)) errors.push({ path: `profiles.${index}.id`, message: `id "${id}" is used twice` });
    seenIds.add(id);
    for (const [moduleKey, moduleGrants] of Object.entries(grants)) {
      const manifest = manifests.find((candidate) => candidate.module.key === moduleKey);
      // A module that isn't loaded yet is allowed, so access can be set up before it arrives.
      if (manifest) errors.push(...checkGrants(moduleGrants, manifest.resources, `profiles.${index}.grants.${moduleKey}`));
    }
    records.push({ _id: id, name, grants, ...(description && { description }) });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: records };
}
