import { ApiError } from '../../../lib/errors.js';
import type { NewLedgerLine } from '../ledger/ledger.service.js';
import { findLedgerAccountById } from '../ledgerAccount/ledgerAccount.repository.js';
import type { JournalVoucherDoc, VoucherType } from '../models/journalVoucher.js';
import type { LedgerLine } from '../models/ledgerEntry.js';

/*
 * Payment and receipt vouchers: a person names one cash or bank account and what the money was for, and these
 * functions turn that into balanced ledger lines. A payment debits each item and credits the money account with the
 * total; a receipt does the opposite. The voucher stores the full lines, so approving, reversing and correcting it
 * work exactly as for a journal voucher.
 */

export type MoneyVoucherType = Exclude<VoucherType, 'journal'>;

/** One thing paid for or received for, in whole paisa or cents. */
export interface MoneyVoucherItem {
  accountId: string;
  amount: number;
  memo?: string;
}

/** The side the items take; the money account takes the other. */
const ITEM_SIDE: Record<MoneyVoucherType, 'debit' | 'credit'> = { payment: 'debit', receipt: 'credit' };
const MONEY_SIDE: Record<MoneyVoucherType, 'debit' | 'credit'> = { payment: 'credit', receipt: 'debit' };

const MONEY_LINE_MEMO: Record<MoneyVoucherType, string> = { payment: 'Paid out', receipt: 'Received' };

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some voucher details are invalid.', [{ path, message }]);

export const isMoneyVoucherType = (voucherType: VoucherType): voucherType is MoneyVoucherType => voucherType !== 'journal';

/** The money account must be an active account marked as cash or a bank account. */
export async function assertIsMoneyAccount(accountId: string): Promise<void> {
  const account = await findLedgerAccountById(accountId);
  if (!account) throw invalid('moneyAccountId', 'no such account');
  if (!account.cashOrBank) throw invalid('moneyAccountId', `${account.code} ${account.name} isn't marked as cash or a bank account`);
  if (!account.isActive) throw invalid('moneyAccountId', `${account.code} ${account.name} is inactive`);
}

/** The balanced lines for a payment or receipt: the items, then one line for the money account with their total. */
export function buildMoneyVoucherLines(voucherType: MoneyVoucherType, moneyAccountId: string, items: MoneyVoucherItem[]): NewLedgerLine[] {
  items.forEach((item, index) => {
    if (item.accountId === moneyAccountId) throw invalid(`lines.${index}.accountId`, 'is the account the money moves through; name what it was for');
  });
  const itemSide = ITEM_SIDE[voucherType];
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  return [
    ...items.map(({ accountId, amount, memo }) => ({ accountId, [itemSide]: amount, ...(memo && { memo }) })),
    { accountId: moneyAccountId, [MONEY_SIDE[voucherType]]: total, memo: MONEY_LINE_MEMO[voucherType] },
  ];
}

/** A saved payment or receipt's items, read back from its lines, so an edit can change the money account alone. */
export function itemsOf(voucher: Pick<JournalVoucherDoc, 'lines' | 'moneyAccountId'> & { voucherType: MoneyVoucherType }): MoneyVoucherItem[] {
  const itemSide = ITEM_SIDE[voucher.voucherType];
  return voucher.lines
    .filter((line) => line.accountId !== voucher.moneyAccountId)
    .map((line) => ({ accountId: line.accountId, amount: line[itemSide], ...(line.memo && { memo: line.memo }) }));
}

/**
 * A correction to a recorded payment or receipt must still move money through its cash or bank account, on the same
 * side, or the voucher would no longer be what its type says. Journal vouchers take any balanced lines.
 */
export function assertKeepsMoneyLine(voucher: Pick<JournalVoucherDoc, 'voucherType' | 'moneyAccountId' | 'number'>, lines: LedgerLine[]): void {
  const voucherType = voucher.voucherType ?? 'journal';
  if (!isMoneyVoucherType(voucherType) || !voucher.moneyAccountId) return;
  const side = MONEY_SIDE[voucherType];
  const keepsIt = lines.some((line) => line.accountId === voucher.moneyAccountId && line[side] > 0);
  if (!keepsIt) {
    throw invalid('changes.lines', `${voucher.number} is a ${voucherType} voucher, so its lines must still ${side} its cash or bank account`);
  }
}
