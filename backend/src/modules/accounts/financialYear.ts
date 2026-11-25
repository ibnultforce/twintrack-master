import { addMonths } from './fixedAsset/depreciation.js';

/*
 * The company's financial year runs from 1 July to 30 June, as in Bangladesh. A year is named by the calendar year it
 * starts in: 2026 is July 2026 to June 2027.
 */

const FIRST_MONTH = '07';
const MONTHS_IN_YEAR = 12;

/** The financial year a YYYY-MM or YYYY-MM-DD falls in: November 2026 and March 2027 are both in 2026. */
export function financialYearOf(date: string): number {
  const [year = 0, month = 0] = date.split('-').map(Number);
  return month >= Number(FIRST_MONTH) ? year : year - 1;
}

/** Its twelve months, July first, as YYYY-MM. */
export const monthsOfFinancialYear = (year: number): string[] =>
  Array.from({ length: MONTHS_IN_YEAR }, (_unused, index) => addMonths(`${year}-${FIRST_MONTH}`, index));

/** Its first and last day, YYYY-MM-DD. */
export const financialYearRange = (year: number) => ({ from: `${year}-07-01`, to: `${year + 1}-06-30` });

/** "July 2026 to June 2027". */
export const financialYearLabel = (year: number) => `July ${year} to June ${year + 1}`;

/** A month's first and last day, YYYY-MM-DD: 2026-11 is 2026-11-01 to 2026-11-30. */
export function monthRange(month: string): { from: string; to: string } {
  const [year = 0, monthNumber = 0] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** The day before a YYYY-MM-DD date. */
export const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
