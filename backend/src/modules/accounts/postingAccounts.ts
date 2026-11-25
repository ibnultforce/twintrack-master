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
  /** VAT paid on purchases, which the company may claim back. */
  vatReceivable: 'la_1700',
  /** Employee and company provident fund shares, held until deposited with the fund. */
  providentFundPayable: 'la_2400',
  /** Gratuity set aside each month, owed to staff when they leave. */
  gratuityPayable: 'la_2500',
  officeRent: 'la_5300',
  serviceIncome: 'la_4100',
  salaryExpense: 'la_5100',
  salariesPayable: 'la_2200',
  /** What employees owe the company: loans and advances, repaid through payroll. */
  employeeLoans: 'la_1400',
  fixedAssets: 'la_1600',
  /** A contra asset: depreciation builds up here instead of lowering the asset's cost. */
  accumulatedDepreciation: 'la_1650',
  depreciationExpense: 'la_5600',
  bonusExpense: 'la_5200',
  commissionExpense: 'la_5250',
  exchangeGain: 'la_4200',
  exchangeLoss: 'la_5800',
} as const;

/**
 * Expense accounts that aren't office running costs: people costs and book entries. The Office expenses screen
 * shows every other expense account.
 */
export const NOT_OFFICE_EXPENSES: readonly string[] = [
  POSTING_ACCOUNTS.salaryExpense,
  POSTING_ACCOUNTS.bonusExpense,
  POSTING_ACCOUNTS.commissionExpense,
  POSTING_ACCOUNTS.depreciationExpense,
  POSTING_ACCOUNTS.exchangeLoss,
];
