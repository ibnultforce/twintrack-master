import type { ApiRoute } from '../../lib/apiRoute.js';
import { approvalRoutes } from './approvals/approvals.routes.js';
import { auditLogRoutes } from './auditLog/auditLog.routes.js';
import { cashBankRoutes } from './cashBank/cashBank.routes.js';
import { changeHistoryRoutes } from './changeHistory/changeHistory.routes.js';
import { journalVoucherRoutes } from './journalVoucher/journalVoucher.routes.js';
import { ledgerAccountRoutes } from './ledgerAccount/ledgerAccount.routes.js';
import { settingsRoutes } from './settings/settings.routes.js';
import { statusRoutes } from './status/status.routes.js';
import { updateRequestRoutes } from './updateRequest/updateRequest.routes.js';

export { ACCOUNTS_MODULE_KEY } from './accountsModule.js';

/** Every built route of the Accounts module. A test checks this list against manifests/accounts.manifest.json. */
export const accountsRoutes: ApiRoute[] = [...statusRoutes, ...settingsRoutes, ...ledgerAccountRoutes, ...journalVoucherRoutes, ...cashBankRoutes, ...updateRequestRoutes, ...changeHistoryRoutes, ...approvalRoutes, ...auditLogRoutes];
