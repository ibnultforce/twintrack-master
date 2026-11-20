import { describe, expect, it } from 'vitest';
import { validateEmployeesFile } from '../src/modules/accounts/employee/employeesFile.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { readSeedFiles } from './helpers/testAccess.js';

const PASSWORD = 'seed-password-for-tests';

describe('dummy employees file', () => {
  it('accepts the committed seed file, with 10 to 15 employees and whole-paisa salaries', () => {
    const result = validateEmployeesFile(readSeedFiles().accountsEmployees);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(10);
    expect(result.value.length).toBeLessThanOrEqual(15);
    expect(result.value.every((employee) => Number.isInteger(employee.monthlySalary))).toBe(true);
  });

  it('refuses repeated ids and codes, taka with decimals, unreal dates and unknown fields', () => {
    const base = { name: 'A', designation: 'B', department: 'c', joinDate: '2026-01-01', monthlySalary: 100 };
    const result = validateEmployeesFile({
      type: 'accountsEmployees',
      employees: [
        { id: 'e1', employeeCode: 'EMP-001', ...base },
        { id: 'e1', employeeCode: 'EMP-001', ...base },
        { id: 'e3', employeeCode: 'EMP-003', ...base, monthlySalary: 450.5 },
        { id: 'e4', employeeCode: 'EMP-004', ...base, joinDate: '2026-02-30' },
        { id: 'e5', employeeCode: 'EMP-005', ...base, salary: 1 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual([
      'employees.1.id',
      'employees.1.employeeCode',
      'employees.2.monthlySalary',
      'employees.3.joinDate',
      'employees.4',
    ]);
  });

  it('refuses a file of the wrong type', () => {
    expect(validateEmployeesFile({ type: 'users', employees: [] }).ok).toBe(false);
  });
});

describe('seeding dummy employees', () => {
  useTestDatabase();

  it('adds every employee once, and a re-run keeps changes made since', async () => {
    const files = readSeedFiles();
    const expected = validateEmployeesFile(files.accountsEmployees);
    if (!expected.ok) throw new Error('seed file invalid');

    await seedDatabase({ files, password: PASSWORD, nodeEnv: 'test' });
    expect(await AccountsEmployee.countDocuments()).toBe(expected.value.length);
    const first = expected.value[0];
    if (!first) throw new Error('seed file has no employees');
    await AccountsEmployee.updateOne({ _id: first._id }, { $set: { designation: 'Changed in the app' } });

    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    expect(await AccountsEmployee.countDocuments()).toBe(expected.value.length);
    const kept = await AccountsEmployee.findById(first._id).lean();
    expect(kept?.designation).toBe('Changed in the app');
    expect(kept?.version).toBe(0);
  });
});
