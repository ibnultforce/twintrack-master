/*
 * Writing CSV files that open cleanly in Excel and Google Sheets. Money leaves the system here as taka with two
 * decimals, the one place paisa become a decimal, and as text, so nothing is rounded on the way.
 */

const PAISA_PER_TAKA = 100;
/** Characters that make a spreadsheet read a text cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** 12345 paisa as "123.45", and -5 as "-0.05": plain digits a spreadsheet reads as a number. */
export function paisaToTaka(paisa: number): string {
  const sign = paisa < 0 ? '-' : '';
  const whole = Math.floor(Math.abs(paisa) / PAISA_PER_TAKA);
  const fraction = String(Math.abs(paisa) % PAISA_PER_TAKA).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

/** An amount of money for a cell, kept apart from text so a negative amount isn't mistaken for a formula. */
export interface Taka {
  taka: string;
}

export const taka = (paisa: number): Taka => ({ taka: paisaToTaka(paisa) });

/** A value a cell can hold. Numbers and money are written as they are; text that would start a formula is defused. */
export type CellValue = string | number | boolean | Taka | null | undefined;

function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return value.taka;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Text such as "=HYPERLINK(...)" typed into a memo would run as a formula when the file is opened.
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * A CSV document: a header row, then one row per record. Starts with a byte order mark so Excel reads "৳" and
 * names in Bangla correctly, and ends lines with CRLF as RFC 4180 asks.
 */
export function toCsv(headers: string[], rows: CellValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(cellText).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
