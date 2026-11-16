import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveDependencies } from '../src/appDependencies.js';
import type { ApiRoute } from '../src/lib/apiRoute.js';
import { createAccountsRoutes } from '../src/modules/accounts/accounts.routes.js';
import { hrRoutes } from '../src/modules/hr/hr.routes.js';
import { validateManifest, type ManifestRoute } from '../src/modules/master/moduleRegistry/manifest.js';
import { createProjectsRoutes } from '../src/modules/projects/projects.routes.js';
import { testRoutes } from '../src/modules/test/test.routes.js';
import { createTestConfig } from './helpers/testConfig.js';

// Master has its own check in routes.test.ts. Every other module's route list must match its manifest too,
// because the Modules and Profiles screens only know what the manifest lists. Add a new module here.
const config = createTestConfig();
const dependencies = resolveDependencies(config);
const moduleRouteLists: Record<string, ApiRoute[]> = {
  hr: hrRoutes,
  projects: createProjectsRoutes(config, dependencies),
  accounts: createAccountsRoutes(config, dependencies),
  test: testRoutes,
};

function loadManifest(moduleKey: string) {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../../manifests/${moduleKey}.manifest.json`, import.meta.url), 'utf8'));
  const manifest = validateManifest(raw);
  if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));
  return manifest.value;
}

const joinPath = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, '')}${path === '/' ? '' : path}` || '/';

const accessRule = ({ method, path, access, permission, anyPermission }: Pick<ApiRoute | ManifestRoute, 'method' | 'path' | 'access' | 'permission' | 'anyPermission'>) =>
  `${method} ${path} ${access} ${permission ?? ''} ${(anyPermission ?? []).join(',')}`.trim();

describe.each(Object.entries(moduleRouteLists))('%s route table', (moduleKey, routes) => {
  it('matches the routes its manifest says are built, including their access rules', () => {
    const manifest = loadManifest(moduleKey);
    const baseUrl = manifest.module.baseUrl ?? `/${moduleKey}`;
    const manifestRoutes = manifest.routes
      .filter((route) => !route.planned)
      .map((route) => accessRule({ ...route, path: joinPath(baseUrl, route.path) }));
    expect(routes.map(accessRule).sort()).toEqual(manifestRoutes.sort());
  });
});
