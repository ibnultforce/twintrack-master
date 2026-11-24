import { ApiError } from '../../../lib/errors.js';
import { isRealDate } from '../ledger/ledger.service.js';

/*
 * Reading a bank's statement CSV (decision 8: CSV only). Banks name their columns differently, so the header row
 * decides: a date column, a description, an optional reference, and either one signed amount column or separate
 * money in and money out columns. Dates may be 2026-11-03, 03/11/2026 or 03-11-2026 (day first, as in Bangladesh).
 */

export interface ParsedStatementLine {
  date: string;
  description: string;
  reference?: string;
  /** Paisa, signed: money in positive. */
  amount: number;
}

const MAX_LINES = 5000;

const HEADER_NAMES = {
  date: ['date', 'transaction date', 'txn date', 'value date', 'posting date'],
  description: ['description', 'details', 'narration', 'particulars', 'remarks'],
  reference: ['reference', 'ref', 'ref no', 'cheque no', 'cheque', 'instrument no'],
  amount: ['amount', 'amount (bdt)', 'net amount'],
  moneyIn: ['credit', 'deposit', 'deposits', 'money in', 'in', 'cr'],
  moneyOut: ['debit', 'withdrawal', 'withdrawals', 'money out', 'out', 'dr'],
} as const;

type Column = keyof typeof HEADER_NAMES;

const invalid = (row: number, message: string) => new ApiError(422, 'invalid_statement', `Row ${row} of the statement: ${message}`, [{ path: 'csv', message: `row ${row}: ${message}` }]);

/** Splits one CSV row, honouring double quotes ("Desh, Ltd") and doubled quotes inside them. */
export function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (inQuotes) {
      if (char === '"' && row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') inQuotes = false;
      else cell += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** "1,23,456.50", "(500.00)" or "-500" as paisa. Undefined for an empty cell; NaN for anything else. */
export function parseAmount(text: string): number | undefined {
  const cleaned = text.replace(/[,\s৳]|tk|bdt/gi, '');
  if (cleaned === '') return undefined;
  const negative = /^\(.*\)$/.test(cleaned) || cleaned.startsWith('-');
  const digits = cleaned.replace(/^\(|\)$/g, '').replace(/^-/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return Number.NaN;
  const [whole = '0', fraction = ''] = digits.split('.');
  const paisa = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -paisa : paisa;
}

/** A statement date as YYYY-MM-DD, or undefined when it isn't a real date in a known form. */
export function parseStatementDate(text: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const date = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : dayFirst ? `${dayFirst[3]}-${dayFirst[2]?.padStart(2, '0')}-${dayFirst[1]?.padStart(2, '0')}` : undefined;
  return date && isRealDate(date) ? date : undefined;
}

function findColumns(header: string[]): Partial<Record<Column, number>> {
  const normalised = header.map((name) => name.toLowerCase().replace(/[^a-z() ]/g, ' ').replace(/\s+/g, ' ').trim());
  const columns: Partial<Record<Column, number>> = {};
  for (const [column, names] of Object.entries(HEADER_NAMES) as [Column, readonly string[]][]) {
    const index = normalised.findIndex((name) => names.includes(name));
    if (index >= 0) columns[column] = index;
  }
  return columns;
}

/** Reads the whole CSV, or refuses it naming the first bad row. Rows with no amount at all (such as a balance line) are skipped. */
export function parseStatementCsv(csv: string): ParsedStatementLine[] {
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/).filter((row) => row.trim() !== '');
  const [header, ...body] = rows;
  if (!header) throw invalid(1, 'the file is empty');
  const columns = findColumns(splitCsvRow(header));
  if (columns.date === undefined) throw invalid(1, 'no Date column');
  if (columns.description === undefined) throw invalid(1, 'no Description column');
  const hasAmount = columns.amount !== undefined;
  if (!hasAmount && (columns.moneyIn === undefined || columns.moneyOut === undefined)) throw invalid(1, 'needs an Amount column, or both Credit (money in) and Debit (money out) columns');
  if (body.length > MAX_LINES) throw invalid(MAX_LINES + 2, `a statement may have at most ${MAX_LINES} lines`);

  return body.flatMap((row, index) => {
    const rowNumber = index + 2;
    const cells = splitCsvRow(row);
    const cell = (column: Column) => (columns[column] === undefined ? '' : cells[columns[column] as number] ?? '');
    let amount: number | undefined;
    if (hasAmount) amount = parseAmount(cell('amount'));
    else {
      const moneyIn = parseAmount(cell('moneyIn'));
      const moneyOut = parseAmount(cell('moneyOut'));
      if (Number.isNaN(moneyIn) || Number.isNaN(moneyOut)) amount = Number.NaN;
      else if (moneyIn !== undefined || moneyOut !== undefined) amount = (moneyIn ?? 0) - Math.abs(moneyOut ?? 0);
    }
    if (amount === undefined) return [];
    if (Number.isNaN(amount)) throw invalid(rowNumber, 'the amount is not a number with up to 2 decimals');
    if (amount === 0) return [];
    const date = parseStatementDate(cell('date'));
    if (!date) throw invalid(rowNumber, `"${cell('date')}" is not a date such as 2026-11-03 or 03/11/2026`);
    const reference = cell('reference');
    return [{ date, description: cell('description') || '(no description)', ...(reference && { reference }), amount }];
  });
}
