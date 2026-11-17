import { readManifestFiles } from '../../src/seed/seedFiles.js';

interface ManifestModule {
  key: string;
  name: string;
}

/** Every module the seed loads, in the seed's order, so tests don't hard-code how many modules exist. */
export const seededModules = (): ManifestModule[] =>
  readManifestFiles().map((manifest) => {
    const { key, name } = (manifest as { module: ManifestModule }).module;
    return { key, name };
  });

/** The same modules sorted by key, as the API lists them. */
export const seededModulesByKey = (): ManifestModule[] => seededModules().sort((first, second) => first.key.localeCompare(second.key));
