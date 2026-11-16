import type { ApiRoute } from '../../lib/apiRoute.js';
import { testRoutes } from './test/test.routes.js';

export { API_TEST_MODULE_KEY } from './apiTestModule.js';

/** Every built route of the API Test module. A test checks this list against manifests/api-test.manifest.json. */
export const apiTestRoutes: ApiRoute[] = [...testRoutes];
