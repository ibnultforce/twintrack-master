import { WITH_DELETED } from '../../lib/records/recordFields.js';
import type { UserReferenceCheck } from '../../lib/userReferences.js';
import { Payment } from './models/money.js';
import { PayrollRun } from './models/payroll.js';

/** Accounts records that keep a person from being deleted, because money was paid to them. */
export const accountsUserReferenceChecks: UserReferenceCheck[] = [
  { description: 'payments', isReferenced: async (userId) => Boolean(await Payment.exists({ payeeUserId: userId }).setOptions(WITH_DELETED)) },
  { description: 'payroll runs', isReferenced: async (userId) => Boolean(await PayrollRun.exists({ 'items.userId': userId }).setOptions(WITH_DELETED)) },
];
