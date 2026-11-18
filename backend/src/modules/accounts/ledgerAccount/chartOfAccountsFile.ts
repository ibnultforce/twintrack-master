import { z } from 'zod';
import { asRecord, fieldErrors, type FieldError, type Validated } from '../../../lib/validation.js';
import { LEDGER_ACCOUNT_TYPES } from '../models/ledgerAccount.js';
import type { LedgerAccountSeedRow } from './ledgerAccount.repository.js';
import { ACCOUNT_CODE_MESSAGE, ACCOUNT_CODE_PATTERN } from './ledgerAccountFields.js';

const accountRowSchema = z.strictObject({
  id: z.string().min(1, 'is required'),
  code: z.string().regex(ACCOUNT_CODE_PATTERN, ACCOUNT_CODE_MESSAGE),
  name: z.string().min(1, 'is required'),
  type: z.enum(LEDGER_ACCOUNT_TYPES),
  parentId: z.string().min(1).optional(),
  description: z.string().optional(),
});

/**
 * Checks the starting chart of accounts. Ids and codes must be unique, and each parent must come earlier in the
 * file with the same type, so the file can't describe a loop. Any problem rejects the whole file.
 */
export function validateChartOfAccountsFile(raw: unknown): Validated<LedgerAccountSeedRow[]> {
  const file = asRecord(raw);
  if (file.type !== 'chartOfAccounts' || !Array.isArray(file.accounts)) {
    return { ok: false, errors: [{ path: '', message: 'expected { "type": "chartOfAccounts", "accounts": [...] }' }] };
  }

  const rows: LedgerAccountSeedRow[] = [];
  const errors: FieldError[] = [];
  const typeById = new Map<string, string>();
  const codes = new Set<string>();
  file.accounts.forEach((row: unknown, index: number) => {
    const path = `accounts.${index}`;
    const parsed = accountRowSchema.safeParse(row);
    if (!parsed.success) {
      errors.push(...fieldErrors(parsed.error.issues, path));
      return;
    }
    const { id, ...account } = parsed.data;
    if (typeById.has(id)) errors.push({ path: `${path}.id`, message: `"${id}" is listed twice` });
    if (codes.has(account.code)) errors.push({ path: `${path}.code`, message: `"${account.code}" is listed twice` });
    if (account.parentId && typeById.get(account.parentId) !== account.type) {
      errors.push({ path: `${path}.parentId`, message: `must be an earlier ${account.type} account in this file` });
    }
    typeById.set(id, account.type);
    codes.add(account.code);
    rows.push({ _id: id, ...account });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: rows };
}
