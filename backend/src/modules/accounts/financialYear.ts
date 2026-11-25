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
