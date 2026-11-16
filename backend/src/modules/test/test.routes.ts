import type { ApiRoute } from '../../lib/apiRoute.js';
import { statusRoutes } from './status/status.routes.js';

export { TEST_MODULE_KEY } from './testModule.js';

/** Every built route of the Test module. A test checks this list against manifests/test.manifest.json. */
export const testRoutes: ApiRoute[] = [...statusRoutes];
