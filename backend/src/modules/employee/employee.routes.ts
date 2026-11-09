import type { ApiRoute } from '../../lib/apiRoute.js';
import { profileRoutes } from './profile/profile.routes.js';

export const EMPLOYEE_MODULE_KEY = 'employee';

/** Every built route of the Employee module. A test checks this list against manifests/employee.manifest.json. */
export const employeeRoutes: ApiRoute[] = [...profileRoutes];
