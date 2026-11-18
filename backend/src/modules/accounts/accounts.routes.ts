import type { ApiRoute } from '../../lib/apiRoute.js';
import { statusRoutes } from './status/status.routes.js';

export const ACCOUNTS_MODULE_KEY = 'accounts';

/** Every built route of the Accounts module. A test checks this list against manifests/accounts.manifest.json. */
export const accountsRoutes: ApiRoute[] = [...statusRoutes];
