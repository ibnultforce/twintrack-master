import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { takeNextDocumentNumber } from '../documentNumbers.js';
import { findLedgerAccountById } from '../ledgerAccount/ledgerAccount.repository.js';
import { BankStatement, type BankStatementDoc, type StatementLine } from '../models/bankStatement.js';
import { LedgerEntry } from '../models/ledgerEntry.js';
import { parseStatementCsv } from './statementCsv.js';

const RESOURCE = 'bankReconciliation';
/** A statement line and a ledger entry this many days apart can still be the same money, such as a cheque clearing. */
const MATCH_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const statementNotFound = () => new ApiError(404, 'unknown_bank_statement', 'No such bank statement.');

const invalid = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const daysApart = (first: string, second: string) => Math.abs(Date.parse(`${first}T00:00:00Z`) - Date.parse(`${second}T00:00:00Z`)) / DAY_MS;

/** One ledger entry seen from the bank account: its net effect on the account (debit positive, as the bank sees money in). */
interface BookItem {
  entryId: string;
  date: string;
  memo: string;
  amount: number;
}

/** The account's ledger entries dated in the period, each with its net effect on the account. */
async function findBookItems(accountId: string, from: string, to: string): Promise<BookItem[]> {
  const rows = await LedgerEntry.aggregate<{ _id: string; date: string; memo: string; amount: number }>([
    { $match: { 'lines.accountId': accountId, entryDate: { $gte: from, $lte: to } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': accountId } },
    { $group: { _id: '$_id', date: { $first: '$entryDate' }, memo: { $first: '$memo' }, amount: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $sort: { date: 1, _id: 1 } },
  ]);
  return rows.filter((row) => row.amount !== 0).map((row) => ({ entryId: row._id, date: row.date, memo: row.memo, amount: row.amount }));
}

/**
 * Entries matched to a line on another of this account's statements, so one entry never clears two lines on it. A
 * transfer between two bank accounts is matched once on each account's statements. `endingBefore` counts only
 * statements whose period ends before that date: what the bank had cleared by then.
 */
async function findMatchedElsewhere(accountId: string, entryIds: string[], options: { exceptStatementId?: string; endingBefore?: string } = {}): Promise<Set<string>> {
  const statements = await BankStatement.find({
    accountId,
    'lines.matchedEntryId': { $in: entryIds },
    ...(options.exceptStatementId && { _id: { $ne: options.exceptStatementId } }),
    ...(options.endingBefore && { to: { $lt: options.endingBefore } }),
  }).select('lines.matchedEntryId').lean();
  return new Set(statements.flatMap((statement) => statement.lines.flatMap((line) => (line.matchedEntryId ? [line.matchedEntryId] : []))));
}

/**
 * Where reconciling the account began: the start of its earliest statement, or of the one being loaded. Entries before
 * it are in the first statement's opening balance. Entries from it on stay open until a statement clears them, so a
 * cheque written in one month and presented in the next is matched on the next month's statement.
 */
async function reconciliationStart(accountId: string, from: string): Promise<string> {
  const first = await BankStatement.findOne({ accountId }).sort({ from: 1 }).select('from').lean();
  return first && first.from < from ? first.from : from;
}

/** The account's entries a statement can match or still waits for: from the start of reconciling to the statement's end. */
async function findOpenBookItems(accountId: string, from: string, to: string): Promise<BookItem[]> {
  return findBookItems(accountId, await reconciliationStart(accountId, from), to);
}

/** The account's balance in the books at the end of a day, from the ledger alone. */
async function bookBalanceAt(accountId: string, date: string): Promise<number> {
  const [totals] = await LedgerEntry.aggregate<{ balance: number }>([
    { $match: { 'lines.accountId': accountId, entryDate: { $lte: date } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': accountId } },
    { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  return totals?.balance ?? 0;
}

/**
 * Pairs each statement line with a free ledger entry for exactly the same amount, the nearest in date within a week.
 * Lines already matched stay as they are. Returns the lines with any new matches.
 */
function autoMatch(lines: StatementLine[], bookItems: BookItem[], takenEntryIds: Set<string>, actorId: string): StatementLine[] {
  const taken = new Set([...takenEntryIds, ...lines.flatMap((line) => (line.matchedEntryId ? [line.matchedEntryId] : []))]);
  return lines.map((line) => {
    if (line.matchedEntryId) return line;
    const candidate = bookItems
      .filter((item) => !taken.has(item.entryId) && item.amount === line.amount && daysApart(item.date, line.date) <= MATCH_WINDOW_DAYS)
      .sort((first, second) => daysApart(first.date, line.date) - daysApart(second.date, line.date))[0];
    if (!candidate) return line;
    taken.add(candidate.entryId);
    return { ...line, matchedEntryId: candidate.entryId, matchedBy: actorId, matchedAt: new Date() };
  });
}

/**
 * The reconciliation: the statement's closing balance should equal the books' balance, plus what the bank has that the
 * books don't yet (unmatched statement lines, such as a bank charge), less what the books have that the bank hasn't
 * cleared yet (unmatched ledger entries, such as a cheque not yet presented). `difference` is what is left unexplained.
 */
async function toView(statement: BankStatementDoc) {
  const [account, bookItems, bookBalance] = await Promise.all([
    findLedgerAccountById(statement.accountId),
    findOpenBookItems(statement.accountId, statement.from, statement.to),
    bookBalanceAt(statement.accountId, statement.to),
  ]);
  const matchedHere = new Set(statement.lines.flatMap((line) => (line.matchedEntryId ? [line.matchedEntryId] : [])));
  // Only earlier statements count as cleared: an entry a later statement matched was still with the bank at this one's end.
  const clearedBefore = await findMatchedElsewhere(statement.accountId, bookItems.map((item) => item.entryId), { exceptStatementId: statement._id, endingBefore: statement.to });
  const itemById = new Map(bookItems.map((item) => [item.entryId, item]));
  const unmatchedBook = bookItems.filter((item) => !matchedHere.has(item.entryId) && !clearedBefore.has(item.entryId));
  const unmatchedLines = statement.lines.filter((line) => !line.matchedEntryId);
  const inBankNotBooks = unmatchedLines.reduce((sum, line) => sum + line.amount, 0);
  const inBooksNotBank = unmatchedBook.reduce((sum, item) => sum + item.amount, 0);
  const difference = statement.closingBalance - (bookBalance + inBankNotBooks - inBooksNotBank);
  const people = new Map((await findUsersByIds([statement.createdBy, statement.reconciledBy].filter((id): id is string => Boolean(id)))).map((person) => [person._id, person.name]));
  return {
    id: statement._id,
    number: statement.number,
    account: account ? { id: account._id, code: account.code, name: account.name, bankName: account.bankName } : { id: statement.accountId },
    from: statement.from,
    to: statement.to,
    openingBalance: statement.openingBalance,
    closingBalance: statement.closingBalance,
    fileName: statement.fileName,
    status: statement.status,
    lines: statement.lines.map((line) => {
      const entry = line.matchedEntryId ? itemById.get(line.matchedEntryId) : undefined;
      return { ...line, ...(entry && { matchedEntry: { date: entry.date, memo: entry.memo } }) };
    }),
    unmatchedBookItems: unmatchedBook,
    summary: {
      bookBalance,
      inBankNotBooks,
      inBooksNotBank,
      adjustedBookBalance: bookBalance + inBankNotBooks - inBooksNotBank,
      difference,
      matchedCount: statement.lines.length - unmatchedLines.length,
      unmatchedCount: unmatchedLines.length,
    },
    canComplete: statement.status === 'open' && difference === 0 && unmatchedLines.length === 0,
    createdBy: statement.createdBy ? { id: statement.createdBy, name: people.get(statement.createdBy) } : undefined,
    createdAt: statement.createdAt,
    reconciledBy: statement.reconciledBy ? { id: statement.reconciledBy, name: people.get(statement.reconciledBy) } : undefined,
    reconciledAt: statement.reconciledAt,
    version: statement.version,
  };
}

async function requireStatement(statementId: string): Promise<BankStatementDoc> {
  const statement = await BankStatement.findById(statementId).lean();
  if (!statement) throw statementNotFound();
  return statement;
}

function assertOpen(statement: BankStatementDoc): void {
  if (statement.status !== 'open') throw new ApiError(409, 'statement_reconciled', `${statement.number} is reconciled, so it can't change.`);
}

const auditFields = (actor: Actor, statement: BankStatementDoc) => ({ ...actorFields(actor), targetType: RESOURCE, targetId: statement._id, targetName: `${statement.number} ${statement.from} to ${statement.to}`, module: ACCOUNTS_MODULE_KEY });

/** Every statement, newest period first, with each account's last reconciled date. */
export async function listBankStatements(accountId?: string) {
  const statements = await BankStatement.find(accountId ? { accountId } : {}).sort({ to: -1, number: -1 }).lean();
  const accounts = new Map<string, string>();
  for (const statement of statements) {
    if (statement.status === 'reconciled' && (!accounts.has(statement.accountId) || statement.to > (accounts.get(statement.accountId) ?? ''))) accounts.set(statement.accountId, statement.to);
  }
  return {
    lastReconciled: Object.fromEntries(accounts),
    statements: statements.map((statement) => ({
      id: statement._id,
      number: statement.number,
      accountId: statement.accountId,
      from: statement.from,
      to: statement.to,
      closingBalance: statement.closingBalance,
      lineCount: statement.lines.length,
      matchedCount: statement.lines.filter((line) => line.matchedEntryId).length,
      status: statement.status,
    })),
  };
}

export async function getBankStatement(statementId: string) {
  return toView(await requireStatement(statementId));
}

export interface StatementImport {
  accountId: string;
  from: string;
  to: string;
  openingBalance: number;
  closingBalance: number;
  csv: string;
  fileName?: string;
}

/**
 * Loads a statement from the bank's CSV and matches what it can. The CSV must add up: opening balance plus its lines
 * equals its closing balance, and every line falls in the period, so a cut-off or wrong file is refused at once.
 */
export async function importBankStatement(actor: Actor, request: StatementImport) {
  const account = await findLedgerAccountById(request.accountId);
  if (!account) throw invalid('accountId', 'no such account');
  if (!account.cashOrBank) throw invalid('accountId', `${account.code} ${account.name} isn't marked as cash or a bank account`);
  const parsed = parseStatementCsv(request.csv);
  if (parsed.length === 0) throw new ApiError(422, 'invalid_statement', 'The statement has no lines with an amount.');
  const outside = parsed.find((line) => line.date < request.from || line.date > request.to);
  if (outside) throw new ApiError(422, 'invalid_statement', `A line dated ${outside.date} is outside ${request.from} to ${request.to}.`, [{ path: 'csv', message: `line dated ${outside.date} is outside the period` }]);
  const sum = parsed.reduce((total, line) => total + line.amount, 0);
  if (request.openingBalance + sum !== request.closingBalance) {
    throw new ApiError(422, 'statement_does_not_add_up', `The opening balance plus the lines comes to ${request.openingBalance + sum} paisa, not the closing balance of ${request.closingBalance}. Check the file and the balances.`);
  }

  const bookItems = await findOpenBookItems(request.accountId, request.from, request.to);
  const taken = await findMatchedElsewhere(request.accountId, bookItems.map((item) => item.entryId));
  const lines = autoMatch(parsed.map((line, index) => ({ id: `sl_${index + 1}`, ...line })), bookItems, taken, actor.user._id);
  const number = await takeNextDocumentNumber('bankStatement', 'BR-');
  const statement = await runInTransaction(async (session) => {
    const [created] = await BankStatement.create([{
      _id: `bs_${randomUUID()}`, number, accountId: request.accountId, from: request.from, to: request.to,
      openingBalance: request.openingBalance, closingBalance: request.closingBalance, ...(request.fileName && { fileName: request.fileName }),
      lines, status: 'open', createdBy: actor.user._id, updatedBy: actor.user._id,
    }], { session });
    if (!created) throw new Error('Creating the bank statement returned nothing.');
    const saved = created.toObject();
    await recordAudit({ action: 'bankReconciliation.imported', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return toView(statement);
}

async function saveLines(actor: Actor, statement: BankStatementDoc, lines: StatementLine[], auditAction: string, version?: number) {
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(BankStatement, statement._id, { $set: { lines } }, { actorId: actor.user._id, expectedVersion: version ?? statement.version, session }, statementNotFound);
    await recordAudit({ action: auditAction, ...auditFields(actor, after) }, session);
    return after;
  });
  return toView(saved);
}

function requireLine(statement: BankStatementDoc, lineId: string): StatementLine {
  const line = statement.lines.find((candidate) => candidate.id === lineId);
  if (!line) throw new ApiError(404, 'unknown_statement_line', 'No such line on this statement.');
  return line;
}

/** Matches a line by hand to a ledger entry on the account for exactly the same amount, not matched anywhere else. */
export async function matchStatementLine(actor: Actor, statementId: string, lineId: string, request: { entryId: string; version?: number }) {
  const statement = await requireStatement(statementId);
  assertOpen(statement);
  const line = requireLine(statement, lineId);
  if (line.matchedEntryId) throw new ApiError(409, 'line_matched', 'This line is already matched. Unmatch it first.');
  const entry = (await findBookItems(statement.accountId, '0000-01-01', '9999-12-31')).find((item) => item.entryId === request.entryId);
  if (!entry) throw invalid('entryId', 'no ledger entry on this account has that id');
  if (entry.amount !== line.amount) throw invalid('entryId', `the entry moves ${entry.amount} paisa on the account, the line ${line.amount}`);
  const usedHere = statement.lines.some((candidate) => candidate.matchedEntryId === request.entryId);
  if (usedHere || (await findMatchedElsewhere(statement.accountId, [request.entryId], { exceptStatementId: statement._id })).size > 0) throw new ApiError(409, 'entry_matched', 'That ledger entry is already matched to another statement line.');
  const lines = statement.lines.map((candidate) => (candidate.id === lineId ? { ...candidate, matchedEntryId: request.entryId, matchedBy: actor.user._id, matchedAt: new Date() } : candidate));
  return saveLines(actor, statement, lines, 'bankReconciliation.matched', request.version);
}

export async function unmatchStatementLine(actor: Actor, statementId: string, lineId: string, version?: number) {
  const statement = await requireStatement(statementId);
  assertOpen(statement);
  const line = requireLine(statement, lineId);
  if (!line.matchedEntryId) throw new ApiError(409, 'line_not_matched', 'This line is not matched.');
  const lines = statement.lines.map((candidate) => (candidate.id === lineId ? { id: candidate.id, date: candidate.date, description: candidate.description, ...(candidate.reference && { reference: candidate.reference }), amount: candidate.amount } : candidate));
  return saveLines(actor, statement, lines, 'bankReconciliation.unmatched', version);
}

/** Matches again any unmatched lines, such as after the missing bank charge was recorded with a voucher. */
export async function rematchStatement(actor: Actor, statementId: string, version?: number) {
  const statement = await requireStatement(statementId);
  assertOpen(statement);
  const bookItems = await findOpenBookItems(statement.accountId, statement.from, statement.to);
  const taken = await findMatchedElsewhere(statement.accountId, bookItems.map((item) => item.entryId), { exceptStatementId: statement._id });
  return saveLines(actor, statement, autoMatch(statement.lines, bookItems, taken, actor.user._id), 'bankReconciliation.matched', version);
}

/**
 * Signs the statement off as reconciled: every line is matched, so the books hold everything the bank did, and nothing
 * is left unexplained. Entries the bank hasn't cleared yet may remain; they show on the next statement.
 */
export async function completeReconciliation(actor: Actor, statementId: string, version?: number) {
  const statement = await requireStatement(statementId);
  assertOpen(statement);
  const view = await toView(statement);
  if (view.summary.unmatchedCount > 0) throw new ApiError(409, 'statement_has_unmatched_lines', `${view.summary.unmatchedCount} statement line${view.summary.unmatchedCount === 1 ? ' is' : 's are'} not in the books yet. Record them with a voucher, then match them.`);
  if (view.summary.difference !== 0) throw new ApiError(409, 'reconciliation_difference', `${view.summary.difference} paisa is still unexplained.`);
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(BankStatement, statement._id, { $set: { status: 'reconciled', reconciledBy: actor.user._id, reconciledAt: new Date() } }, { actorId: actor.user._id, expectedVersion: version ?? statement.version, session }, statementNotFound);
    await recordAudit({ action: 'bankReconciliation.completed', ...auditFields(actor, after) }, session);
    return after;
  });
  return toView(saved);
}
