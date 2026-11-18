import type { ApiRoute } from '../../lib/apiRoute.js';
import { ledgerAccountRoutes } from './ledgerAccount/ledgerAccount.routes.js';
import { statusRoutes } from './status/status.routes.js';

export { ACCOUNTS_MODULE_KEY } from './accountsModule.js';

/** Every built route of the Accounts module. A test checks this list against manifests/accounts.manifest.json. */
export const accountsRoutes: ApiRoute[] = [...statusRoutes, ...ledgerAccountRoutes];
