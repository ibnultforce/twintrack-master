import type { ApiRoute } from '../../lib/apiRoute.js';
import { approvalRoutes } from './approvals/approvals.routes.js';
import { billRoutes } from './bill/bill.routes.js';
import { auditLogRoutes } from './auditLog/auditLog.routes.js';
import { cashBankRoutes } from './cashBank/cashBank.routes.js';
import { changeHistoryRoutes } from './changeHistory/changeHistory.routes.js';
import { clientAccountRoutes } from './clientAccount/clientAccount.routes.js';
import { fixedAssetRoutes } from './fixedAsset/fixedAsset.routes.js';
import { inventoryRoutes } from './inventory/inventory.routes.js';
import { invoiceRoutes } from './invoice/invoice.routes.js';
import { journalVoucherRoutes } from './journalVoucher/journalVoucher.routes.js';
import { ledgerAccountRoutes } from './ledgerAccount/ledgerAccount.routes.js';
import { payrollRoutes } from './payroll/payroll.routes.js';
import { settingsRoutes } from './settings/settings.routes.js';
import { statusRoutes } from './status/status.routes.js';
import { updateRequestRoutes } from './updateRequest/updateRequest.routes.js';
import { vendorRoutes } from './vendor/vendor.routes.js';

export { ACCOUNTS_MODULE_KEY } from './accountsModule.js';

/** Every built route of the Accounts module. A test checks this list against manifests/accounts.manifest.json. */
export const accountsRoutes: ApiRoute[] = [...statusRoutes, ...settingsRoutes, ...ledgerAccountRoutes, ...journalVoucherRoutes, ...cashBankRoutes, ...clientAccountRoutes, ...invoiceRoutes, ...vendorRoutes, ...billRoutes, ...payrollRoutes, ...fixedAssetRoutes, ...inventoryRoutes, ...updateRequestRoutes, ...changeHistoryRoutes, ...approvalRoutes, ...auditLogRoutes];
