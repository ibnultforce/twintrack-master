/**
 * The chart accounts that invoices, bills and their payments post to, by their ids in the starting chart
 * (seed/chart-of-accounts.json). Kept in one place so a later Settings choice can replace them without touching
 * the features. Accounts are never deleted, so these ids stay valid; a deactivated one makes posting fail with 422.
 */
export const POSTING_ACCOUNTS = {
  receivable: 'la_1300',
  payable: 'la_2100',
  /** Tax deducted at source from vendor bills, owed to the tax authority. */
  taxPayable: 'la_2300',
  serviceIncome: 'la_4100',
  exchangeGain: 'la_4200',
  exchangeLoss: 'la_5800',
} as const;
