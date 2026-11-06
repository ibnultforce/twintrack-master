import type { Config } from '../../config.js';
import type { ApiRoute } from '../../lib/apiRoute.js';
import { createAuthRoutes } from './auth/auth.routes.js';
import { healthRoutes } from './health/health.routes.js';

/** Every route of the Master module. A test checks this list against manifests/master.manifest.json. */
export function createMasterRoutes(config: Config): ApiRoute[] {
  return [...healthRoutes, ...createAuthRoutes(config)];
}
