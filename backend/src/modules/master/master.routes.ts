import type { Config } from '../../config.js';
import type { ApiRoute } from '../../lib/apiRoute.js';
import { createAccessRoutes } from './access/access.routes.js';
import { auditRoutes } from './audit/audit.routes.js';
import { createAuthRoutes } from './auth/auth.routes.js';
import { healthRoutes } from './health/health.routes.js';
import { createModuleRegistryRoutes } from './moduleRegistry/moduleRegistry.routes.js';
import { usersRoutes } from './users/users.routes.js';

export { MASTER_MODULE_KEY } from './moduleRegistry/manifest.js';

/** Every route of the Master module. A test checks this list against manifests/master.manifest.json. */
export function createMasterRoutes(config: Config): ApiRoute[] {
  return [
    ...healthRoutes,
    ...createAuthRoutes(config),
    ...createAccessRoutes(config),
    ...usersRoutes,
    ...createModuleRegistryRoutes(config),
    ...auditRoutes,
  ];
}
