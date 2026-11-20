import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import { isRealDate } from '../ledger/ledger.service.js';
import type { EmployeeSeedRow } from './employee.repository.js';

/** 1 crore taka a month, in paisa: far above any real salary, so a typo with extra zeros is caught. */
const MAX_MONTHLY_SALARY_PAISA = 10_000_000_00;

const employeeRowSchema = z.strictObject({
  id: z.string().min(1, 'is required'),
  employeeCode: z.string().regex(/^EMP-\d{3,6}$/, 'must look like EMP-001'),
  name: z.string().min(1, 'is required').max(200),
  designation: z.string().min(1, 'is required').max(200),
  department: z.string().min(1, 'is required').max(100),
  joinDate: z.string().refine(isRealDate, 'must be a real YYYY-MM-DD date'),
  monthlySalary: z.number().int('must be whole paisa').positive().max(MAX_MONTHLY_SALARY_PAISA),
  bankAccountNumber: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{2,33}$/, 'must be 3 to 34 letters, digits, spaces or hyphens')
    .optional(),
  isActive: z.boolean().default(true),
});

/** Checks the dummy employees file. Ids and employee codes must be unique; any problem rejects the whole file. */
export function validateEmployeesFile(raw: unknown): Validated<EmployeeSeedRow[]> {
  const file = asRecord(raw);
  if (file.type !== 'accountsEmployees' || !Array.isArray(file.employees)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "accountsEmployees", "employees": [...] }' }] };
  }

  const rows: EmployeeSeedRow[] = [];
  const errors: FieldError[] = [];
  const ids = new Set<string>();
  const codes = new Set<string>();
  file.employees.forEach((row: unknown, index: number) => {
    const path = `employees.${index}`;
    const parsed = employeeRowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(...fieldErrors(parsed.error.issues, path));
      return;
    }
    const { id, ...employee } = parsed.data;
    if (ids.has(id)) errors.push({ path: `${path}.id`, message: `"${id}" is listed twice` });
    if (codes.has(employee.employeeCode)) errors.push({ path: `${path}.employeeCode`, message: `"${employee.employeeCode}" is listed twice` });
    ids.add(id);
    codes.add(employee.employeeCode);
    rows.push({ _id: id, ...employee });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rows };
}
