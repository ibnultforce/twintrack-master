import { z } from 'zod';
import { isRealDate } from './ledger/ledger.service.js';

/** Request fields shared by Accounts routes, so every route checks dates, amounts and versions the same way. */

/** An accounting date, YYYY-MM-DD. */
export const accountingDateField = z.string().refine(isRealDate, 'must be a real date as YYYY-MM-DD');

/** Whole paisa or cents, zero or more. */
export const minorUnitsField = z.number().int('must be whole paisa or cents').min(0).max(Number.MAX_SAFE_INTEGER);

export const versionField = z.number().int().min(0);

export const recordIdField = z.string().min(1, 'is required').max(100);

/** A month, YYYY-MM. */
export const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month as YYYY-MM');

/** A financial year, named by the calendar year it starts in (2026 is July 2026 to June 2027). Optional: the current one. */
export const financialYearQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
