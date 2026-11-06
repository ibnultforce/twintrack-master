import type { ApiRoute } from '../../lib/apiRoute.js';
import { salaryRoutes } from './salary/salary.routes.js';

export const HR_MODULE_KEY = 'hr';

/** Every built route of the HR module. A test checks this list against manifests/hr.manifest.json. */
export const hrRoutes: ApiRoute[] = [...salaryRoutes];
