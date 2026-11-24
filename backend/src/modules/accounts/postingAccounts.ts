/**
 * The chart accounts that invoices, bills, payroll, depreciation and their payments post to, by their ids in the starting chart
 * (seed/chart-of-accounts.json). Kept in one place so a later Settings choice can replace them without touching
 * the features. Accounts are never deleted, so these ids stay valid; a deactivated one makes posting fail with 422.
 */
export const POSTING_ACCOUNTS = {
  receivable: 'la_1300',
  payable: 'la_2100',
  /** Tax deducted at source from vendor bills, owed to the tax authority. */
  taxPayable: 'la_2300',
  serviceIncome: 'la_4100',
  salaryExpense: 'la_5100',
  salariesPayable: 'la_2200',
  fixedAssets: 'la_1600',
  /** A contra asset: depreciation builds up here instead of lowering the asset's cost. */
  accumulatedDepreciation: 'la_1650',
  depreciationExpense: 'la_5600',
  exchangeGain: 'la_4200',
  exchangeLoss: 'la_5800',
} as const;
