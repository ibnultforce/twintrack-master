import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import { SALARY_STATUSES } from '../models/salary.js';
import type { SalarySeedRow } from './salary.repository.js';

const salaryRowSchema = z.object({
  id: z.string().min(1, 'is required'),
  employeeId: z.string().min(1, 'is required'),
  amount: z.number().positive('must be above zero'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter code'),
  effectiveFrom: z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value)),
  status: z.enum(SALARY_STATUSES),
});

/** Checks the sample salaries file. Any problem rejects the file, like the users file. */
export function validateSalariesFile(raw: unknown, employeeIds: Set<string>): Validated<SalarySeedRow[]> {
  const file = asRecord(raw);
  if (file.type !== 'salaries' || !Array.isArray(file.salaries)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "salaries", "salaries": [...] }' }] };
  }

  const rows: SalarySeedRow[] = [];
  const errors: FieldError[] = [];
  file.salaries.forEach((row: unknown, index: number) => {
    const parsed = salaryRowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(...fieldErrors(parsed.error.issues, `salaries.${index}`));
      return;
    }
    const { id, ...salary } = parsed.data;
    if (!employeeIds.has(salary.employeeId)) errors.push({ path: `salaries.${index}.employeeId`, message: `"${salary.employeeId}" is not in the users file` });
    rows.push({ _id: id, ...salary });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rows };
}
