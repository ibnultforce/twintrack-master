import type { ApiRoute } from '../../lib/apiRoute.js';
import { healthRoutes } from './health/health.routes.js';
import { testRoutes } from './test/test.routes.js';

export { NEW_TEST_MODULE_KEY } from './newTestModule.js';

/** Every built route of the New test module. A test checks this list against manifests/new-test.manifest.json. */
export const newTestRoutes: ApiRoute[] = [...testRoutes, ...healthRoutes];
