import type { AppDependencies } from '../../appDependencies.js';
import type { Config } from '../../config.js';
import type { ApiRoute } from '../../lib/apiRoute.js';
import { createSecretCipher } from '../../lib/encryption.js';
import { createBankAccountRoutes } from './bankAccount/bankAccount.routes.js';
import { billRoutes } from './bill/bill.routes.js';
import { categoryRoutes } from './category/category.routes.js';
import { createDocumentRoutes } from './document/document.routes.js';
import { createInvoiceRoutes } from './invoice/invoice.routes.js';
import { paymentRoutes } from './payment/payment.routes.js';
import { payrollRoutes } from './payroll/payroll.routes.js';
import { receiptRoutes } from './receipt/receipt.routes.js';
import { createVendorRoutes } from './vendor/vendor.routes.js';

export { ACCOUNTS_MODULE_KEY } from './accountsModule.js';

/** Every built route of the Accounts module. A test checks this list against manifests/accounts.manifest.json. */
export function createAccountsRoutes(config: Config, dependencies: Pick<AppDependencies, 'fileStorage' | 'emailSender'>): ApiRoute[] {
  const cipher = createSecretCipher(config.encryptionKey);
  return [
    ...categoryRoutes,
    ...createVendorRoutes(cipher),
    ...createBankAccountRoutes(cipher),
    ...billRoutes,
    ...paymentRoutes,
    ...receiptRoutes,
    ...createInvoiceRoutes(config.accounts, dependencies.fileStorage, dependencies.emailSender),
    ...payrollRoutes,
    ...createDocumentRoutes(dependencies.fileStorage),
  ];
}
