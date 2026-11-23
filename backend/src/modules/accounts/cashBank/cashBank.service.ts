import type { Actor } from '../../master/access/caller.js';
import { readFieldRules, redactRecord } from '../../master/records/fieldSecurity.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { sumLinesForPeriod } from '../ledger/ledger.repository.js';
import { findCashAndBankAccounts } from '../ledgerAccount/ledgerAccount.repository.js';
import { maskBankAccountNumber } from '../ledgerAccount/ledgerAccountFields.js';

/*
 * The Cash and bank screen. Every figure comes from ledger lines: an account's balance is never typed in, and an
 * opening balance is itself a voucher posted against Opening balance equity.
 */

export interface CashBankPeriod {
  /** First and last day, YYYY-MM-DD. */
  from: string;
  to: string;
}

const LEDGER_ACCOUNT_RESOURCE = 'ledgerAccount';

/**
 * Each cash and bank account with its balance at the start of the period, the money in and out during it, and its
 * balance at the end, plus the totals. Inactive accounts are shown only if they had money in the period. A bank
 * number is hidden exactly as it is in the chart of accounts, and masked for those who may see it.
 */
export async function getCashAndBank(actor: Actor, period: CashBankPeriod) {
  const [accounts, rules] = await Promise.all([findCashAndBankAccounts(), readFieldRules(actor, ACCOUNTS_MODULE_KEY, LEDGER_ACCOUNT_RESOURCE)]);
  const totals = new Map((await sumLinesForPeriod(accounts.map((account) => account._id), period.from, period.to)).map((row) => [row.accountId, row]));

  const rows = accounts
    .map((account) => {
      const { opening = 0, debit: moneyIn = 0, credit: moneyOut = 0 } = totals.get(account._id) ?? {};
      return {
        account,
        figures: { opening, moneyIn, moneyOut, balance: opening + moneyIn - moneyOut },
      };
    })
    .filter(({ account, figures }) => account.isActive || Object.values(figures).some((amount) => amount !== 0))
    .map(({ account, figures }) => redactRecord({
      id: account._id,
      code: account.code,
      name: account.name,
      cashOrBank: account.cashOrBank,
      bankName: account.bankName,
      bankAccountNumber: account.bankAccountNumber && maskBankAccountNumber(account.bankAccountNumber),
      isActive: account.isActive,
      ...figures,
    }, rules));

  const sum = (field: 'opening' | 'moneyIn' | 'moneyOut' | 'balance') => rows.reduce((total, row) => total + row[field], 0);
  return {
    ...period,
    accounts: rows,
    totals: { opening: sum('opening'), moneyIn: sum('moneyIn'), moneyOut: sum('moneyOut'), balance: sum('balance') },
  };
}
