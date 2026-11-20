import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { isDuplicateKeyError } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { findAccountsWithChildren, findLedgerAccountsByIds } from '../ledgerAccount/ledgerAccount.repository.js';
import type { LedgerAccountType } from '../models/ledgerAccount.js';
import type { LedgerEntryDoc, LedgerEntrySource, LedgerLine } from '../models/ledgerEntry.js';
import { findLedgerEntryById, insertLedgerEntry, markLedgerEntryReversed, sumLinesByAccount } from './ledger.repository.js';

/*
 * The ledger core. These are the only functions that write ledger entries; every money feature (vouchers, bills,
 * payroll) calls them inside its own transaction, so its record, its history and its ledger lines save together.
 */

const LEDGER_ENTRY_TARGET = 'ledgerEntry';
const MIN_LINES = 2;
const ENTRY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface NewLedgerLine {
  accountId: string;
  /** Whole paisa or cents. Leave out, or send 0, for the side the line doesn't use. */
  debit?: number;
  credit?: number;
  memo?: string;
}

export interface NewLedgerEntry {
  /** YYYY-MM-DD. */
  entryDate: string;
  memo: string;
  /** The record that caused the entry, such as a voucher, so the ledger can be traced back to it. */
  source: LedgerEntrySource;
  lines: NewLedgerLine[];
}

export interface ReverseOptions {
  /** The reversal's date, YYYY-MM-DD. Defaults to today. */
  entryDate?: string;
  memo?: string;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  debit: number;
  credit: number;
  /** Debits minus credits, so a positive figure is a debit balance. */
  balance: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** Debits minus credits across the whole ledger. Always zero unless something bypassed postEntry. */
  difference: number;
}

const unbalanced = (message: string, path = 'lines') => new ApiError(422, 'unbalanced_entry', message, [{ path, message }]);

const invalidLine = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some ledger lines are invalid.', [{ path, message }]);

const ledgerEntryNotFound = () => new ApiError(404, 'unknown_ledger_entry', 'No such ledger entry.');

const alreadyReversed = () => new ApiError(409, 'entry_already_reversed', 'This ledger entry has already been reversed.');

/** Today's date as YYYY-MM-DD in the server's time zone, which is set with TZ. */
export function todayAsEntryDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether the text is a real calendar date written as YYYY-MM-DD. */
export function isRealDate(text: string): boolean {
  if (!ENTRY_DATE_PATTERN.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

const isWholeAmount = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;

/** Each line has one side above zero, in whole minor units. Returns the lines with both sides filled in. */
function checkLineAmounts(lines: NewLedgerLine[]): LedgerLine[] {
  if (lines.length < MIN_LINES) throw unbalanced(`An entry needs at least ${MIN_LINES} lines.`);
  return lines.map(({ accountId, debit = 0, credit = 0, memo }, index) => {
    const path = `lines.${index}`;
    if (!isWholeAmount(debit) || !isWholeAmount(credit)) throw invalidLine(path, 'amounts must be whole paisa or cents, zero or more');
    if ((debit > 0) === (credit > 0)) throw invalidLine(path, 'needs either a debit or a credit above zero, not both');
    return { accountId, debit, credit, ...(memo && { memo }) };
  });
}

function sumSide(lines: LedgerLine[], side: 'debit' | 'credit'): number {
  const total = lines.reduce((sum, line) => sum + line[side], 0);
  if (!Number.isSafeInteger(total)) throw unbalanced('The amounts are too large to add up exactly.');
  return total;
}

/** Lines may post only to active accounts that have no sub-accounts: a group such as "Assets" holds no money itself. */
async function checkLineAccounts(lines: LedgerLine[]): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = new Map((await findLedgerAccountsByIds(accountIds)).map((account) => [account._id, account]));
  const groupIds = new Set(await findAccountsWithChildren(accountIds));
  lines.forEach((line, index) => {
    const account = accounts.get(line.accountId);
    const path = `lines.${index}.accountId`;
    if (!account) throw invalidLine(path, 'no such account');
    if (!account.isActive) throw invalidLine(path, `${account.code} ${account.name} is inactive`);
    if (groupIds.has(line.accountId)) throw invalidLine(path, `${account.code} ${account.name} groups other accounts, so post to one of them`);
  });
}

/**
 * Checks lines the way postEntry will, so a draft that names a missing account or doesn't balance is refused when it
 * is saved, not later. Returns the lines with both sides filled in, and their total.
 */
export async function checkBalancedLines(newLines: NewLedgerLine[]): Promise<{ lines: LedgerLine[]; total: number }> {
  const lines = checkLineAmounts(newLines);
  const totalDebit = sumSide(lines, 'debit');
  const totalCredit = sumSide(lines, 'credit');
  if (totalDebit !== totalCredit) {
    throw unbalanced(`Debits (${totalDebit}) and credits (${totalCredit}) must be equal.`);
  }
  await checkLineAccounts(lines);
  return { lines, total: totalDebit };
}

const auditFields = (actor: Actor, entry: LedgerEntryDoc) => ({
  ...actorFields(actor),
  targetType: LEDGER_ENTRY_TARGET,
  targetId: entry._id,
  targetName: entry.memo,
  module: ACCOUNTS_MODULE_KEY,
});

/**
 * Writes one balanced entry. Refuses fewer than two lines, a line with both or neither side, amounts that aren't
 * whole minor units, accounts that are missing, inactive or groups, and debits that don't equal credits.
 * Runs inside the caller's transaction.
 */
export async function postEntry(actor: Actor, entry: NewLedgerEntry, session: ClientSession): Promise<LedgerEntryDoc> {
  if (!isRealDate(entry.entryDate)) throw invalidLine('entryDate', 'must be a real date as YYYY-MM-DD');
  const memo = entry.memo.trim();
  if (!memo) throw invalidLine('memo', 'is required');

  if (!entry.source?.type?.trim() || !entry.source.id?.trim()) throw invalidLine('source', 'must name the record that caused the entry');

  const { lines, total } = await checkBalancedLines(entry.lines);

  const created = await insertLedgerEntry(
    { _id: `le_${randomUUID()}`, entryDate: entry.entryDate, memo, source: entry.source, lines, total, createdBy: actor.user._id },
    session,
  );
  await recordAudit({ action: 'ledgerEntry.posted', ...auditFields(actor, created) }, session);
  return created;
}

/**
 * Cancels an entry with a new one whose lines are the original's with debit and credit swapped, dated today unless
 * told otherwise. The original is never changed beyond pointing at its reversal. An entry can be reversed once, and
 * a reversal itself can't be reversed: post a new entry instead. Inactive accounts are allowed here, because undoing
 * a mistake must work even after an account is closed.
 */
export async function reverseEntry(actor: Actor, entryId: string, session: ClientSession, options: ReverseOptions = {}): Promise<LedgerEntryDoc> {
  const entryDate = options.entryDate ?? todayAsEntryDate();
  if (!isRealDate(entryDate)) throw invalidLine('entryDate', 'must be a real date as YYYY-MM-DD');

  const original = await findLedgerEntryById(entryId, session);
  if (!original) throw ledgerEntryNotFound();
  if (original.reversalOf) throw new ApiError(409, 'entry_is_a_reversal', 'A reversal can\'t be reversed. Post a new entry instead.');
  if (original.reversedBy) throw alreadyReversed();

  const reversalId = `le_${randomUUID()}`;
  try {
    const reversal = await insertLedgerEntry(
      {
        _id: reversalId,
        entryDate,
        memo: options.memo?.trim() || `Reversal of: ${original.memo}`,
        source: original.source,
        lines: original.lines.map(({ accountId, debit, credit, memo }) => ({ accountId, debit: credit, credit: debit, ...(memo && { memo }) })),
        total: original.total,
        reversalOf: original._id,
        createdBy: actor.user._id,
      },
      session,
    );
    if (!(await markLedgerEntryReversed(original._id, reversalId, session))) throw alreadyReversed();
    await recordAudit({ action: 'ledgerEntry.reversed', ...auditFields(actor, original) }, session);
    return reversal;
  } catch (error) {
    // Another reversal of the same entry won the race; the unique index on reversalOf refused this one.
    if (isDuplicateKeyError(error)) throw alreadyReversed();
    throw error;
  }
}

/** Every account with ledger lines, its debit and credit totals, and the grand totals, which must be equal. */
export async function getTrialBalance(upToDate?: string, session?: ClientSession): Promise<TrialBalance> {
  const totals = await sumLinesByAccount(upToDate, session);
  const accounts = new Map((await findLedgerAccountsByIds(totals.map((row) => row.accountId))).map((account) => [account._id, account]));
  const rows = totals
    .map(({ accountId, debit, credit }) => {
      const account = accounts.get(accountId);
      if (!account) throw new Error(`Ledger lines name the account ${accountId}, which is missing from the chart.`);
      return { accountId, code: account.code, name: account.name, type: account.type, debit, credit, balance: debit - credit };
    })
    .sort((first, second) => first.code.localeCompare(second.code));
  const totalDebit = rows.reduce((sum, row) => sum + row.debit, 0);
  const totalCredit = rows.reduce((sum, row) => sum + row.credit, 0);
  return { rows, totalDebit, totalCredit, difference: totalDebit - totalCredit };
}
