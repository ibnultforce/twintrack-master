import { beforeEach, describe, expect, it } from 'vitest';
import { runInTransaction } from '../src/db.js';
import { ApiError } from '../src/lib/errors.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { getTrialBalance, postEntry, reverseEntry, todayAsEntryDate, type NewLedgerEntry } from '../src/modules/accounts/ledger/ledger.service.js';
import { LedgerAccount } from '../src/modules/accounts/models/ledgerAccount.js';
import { LedgerEntry } from '../src/modules/accounts/models/ledgerEntry.js';
import type { Actor } from '../src/modules/master/access/caller.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';

const CASH = 'la_1100';
const BANK = 'la_1200';
const CAPITAL = 'la_3100';
const RENT = 'la_5300';
const BANK_CHARGES = 'la_5700';
const ASSETS_GROUP = 'la_1000';

/** Owner puts 50,000.00 into the bank: amounts are in paisa. */
const capitalIntoBank: NewLedgerEntry = {
  entryDate: '2026-11-02',
  memo: 'Owner capital',
  source: { type: 'journalVoucher', id: 'jv_1' },
  lines: [
    { accountId: BANK, debit: 5_000_000 },
    { accountId: CAPITAL, credit: 5_000_000 },
  ],
};

let actor: Actor;

const post = (entry: NewLedgerEntry) => runInTransaction((session) => postEntry(actor, entry, session));
const reverse = (entryId: string, entryDate?: string) => runInTransaction((session) => reverseEntry(actor, entryId, session, { entryDate }));

/** Runs the call and returns the ApiError it threw, failing the test if it threw nothing or something else. */
async function refusal(call: () => Promise<unknown>): Promise<ApiError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused, but it succeeded.');
}

describe('ledger core', () => {
  useTestDatabase();

  beforeEach(async () => {
    const chart = validateChartOfAccountsFile(readSeedFiles().chartOfAccounts);
    if (!chart.ok) throw new Error(JSON.stringify(chart.errors));
    await runInTransaction((session) => insertMissingLedgerAccounts(chart.value, session));
    const user = (await addPerson('amina')).toObject();
    actor = { user, profile: null, ipAddress: '127.0.0.1', permissions: {}, fieldAccess: {} };
  });

  describe('postEntry', () => {
    it('writes a balanced entry with its total, author and an audit entry', async () => {
      const entry = await post(capitalIntoBank);
      expect(entry).toMatchObject({ entryDate: '2026-11-02', memo: 'Owner capital', source: { type: 'journalVoucher', id: 'jv_1' }, total: 5_000_000, createdBy: 'amina' });
      expect(entry.lines).toEqual([
        { accountId: BANK, debit: 5_000_000, credit: 0 },
        { accountId: CAPITAL, debit: 0, credit: 5_000_000 },
      ]);
      expect(await AuditLog.countDocuments({ action: 'ledgerEntry.posted', targetId: entry._id, actorId: 'amina' })).toBe(1);
    });

    it('accepts more than two lines when they balance', async () => {
      const entry = await post({
        entryDate: '2026-11-03',
        memo: 'Rent paid with a bank charge',
        source: { type: 'paymentVoucher', id: 'pv_1' },
        lines: [
          { accountId: RENT, debit: 2_500_000 },
          { accountId: BANK_CHARGES, debit: 5_000 },
          { accountId: BANK, credit: 2_505_000 },
        ],
      });
      expect(entry.total).toBe(2_505_000);
    });

    it('keeps a 1 paisa amount exact', async () => {
      const entry = await post({ ...capitalIntoBank, lines: [{ accountId: BANK_CHARGES, debit: 1 }, { accountId: BANK, credit: 1 }] });
      expect(entry.total).toBe(1);
      expect((await getTrialBalance()).rows.map(({ code, debit, credit }) => [code, debit, credit])).toEqual([['1200', 0, 1], ['5700', 1, 0]]);
    });

    it.each([
      ['no source', undefined],
      ['a source with no id', { type: 'journalVoucher', id: ' ' }],
    ])('refuses an entry with %s, since every entry must be traceable', async (_label, source) => {
      const error = await refusal(() => post({ ...capitalIntoBank, source: source as NewLedgerEntry['source'] }));
      expect(error.fields).toEqual([{ path: 'source', message: 'must name the record that caused the entry' }]);
      expect(await LedgerEntry.countDocuments()).toBe(0);
    });

    it('refuses an unbalanced entry and writes nothing', async () => {
      const error = await refusal(() => post({ ...capitalIntoBank, lines: [{ accountId: BANK, debit: 5_000_000 }, { accountId: CAPITAL, credit: 4_999_999 }] }));
      expect(error).toMatchObject({ status: 422, code: 'unbalanced_entry' });
      expect(error.message).toBe('Debits (5000000) and credits (4999999) must be equal.');
      expect(await LedgerEntry.countDocuments()).toBe(0);
      expect(await AuditLog.countDocuments({ action: 'ledgerEntry.posted' })).toBe(0);
    });

    it('refuses an entry with only one line', async () => {
      const error = await refusal(() => post({ ...capitalIntoBank, lines: [{ accountId: BANK, debit: 0, credit: 0 }] }));
      expect(error).toMatchObject({ status: 422, code: 'unbalanced_entry' });
    });

    it.each([
      ['both sides', { debit: 100, credit: 100 }, 'needs either a debit or a credit above zero, not both'],
      ['neither side', { debit: 0, credit: 0 }, 'needs either a debit or a credit above zero, not both'],
      ['a fraction of a paisa', { debit: 100.5 }, 'amounts must be whole paisa or cents, zero or more'],
      ['a negative amount', { debit: -100 }, 'amounts must be whole paisa or cents, zero or more'],
    ])('refuses a line with %s', async (_label, amounts, message) => {
      const error = await refusal(() => post({ ...capitalIntoBank, lines: [{ accountId: BANK, ...amounts }, { accountId: CAPITAL, credit: 100 }] }));
      expect(error).toMatchObject({ status: 422, code: 'validation_failed', fields: [{ path: 'lines.0', message }] });
    });

    it('refuses an unknown account, an inactive one and a group account', async () => {
      const withFirstAccount = (accountId: string) => post({ ...capitalIntoBank, lines: [{ accountId, debit: 100 }, { accountId: CAPITAL, credit: 100 }] });

      expect((await refusal(() => withFirstAccount('la_missing'))).fields).toEqual([{ path: 'lines.0.accountId', message: 'no such account' }]);

      await LedgerAccount.updateOne({ _id: CASH }, { $set: { isActive: false } });
      expect((await refusal(() => withFirstAccount(CASH))).fields).toEqual([{ path: 'lines.0.accountId', message: '1100 Cash in hand is inactive' }]);

      expect((await refusal(() => withFirstAccount(ASSETS_GROUP))).fields).toEqual([{ path: 'lines.0.accountId', message: '1000 Assets groups other accounts, so post to one of them' }]);
      expect(await LedgerEntry.countDocuments()).toBe(0);
    });

    it.each(['2026-02-30', '2026-13-01', '02/11/2026', ''])('refuses the entry date "%s"', async (entryDate) => {
      expect((await refusal(() => post({ ...capitalIntoBank, entryDate }))).fields).toEqual([{ path: 'entryDate', message: 'must be a real date as YYYY-MM-DD' }]);
    });

    it('refuses a blank memo', async () => {
      expect((await refusal(() => post({ ...capitalIntoBank, memo: '   ' }))).fields).toEqual([{ path: 'memo', message: 'is required' }]);
    });

    it("saves nothing when the caller's transaction fails after posting", async () => {
      await expect(runInTransaction(async (session) => {
        await postEntry(actor, capitalIntoBank, session);
        throw new Error('the voucher could not be saved');
      })).rejects.toThrow('the voucher could not be saved');
      expect(await LedgerEntry.countDocuments()).toBe(0);
      expect(await AuditLog.countDocuments({ action: 'ledgerEntry.posted' })).toBe(0);
    });
  });

  describe('reverseEntry', () => {
    it('writes mirror lines dated today and links the two entries', async () => {
      const original = await post(capitalIntoBank);
      const reversal = await reverse(original._id);

      expect(reversal).toMatchObject({ entryDate: todayAsEntryDate(), memo: 'Reversal of: Owner capital', source: capitalIntoBank.source, total: 5_000_000, reversalOf: original._id });
      expect(reversal.lines).toEqual([
        { accountId: BANK, debit: 0, credit: 5_000_000 },
        { accountId: CAPITAL, debit: 5_000_000, credit: 0 },
      ]);
      const stored = await LedgerEntry.findById(original._id).lean();
      expect(stored).toMatchObject({ reversedBy: reversal._id, lines: original.lines, entryDate: original.entryDate, memo: original.memo });
      expect(await AuditLog.countDocuments({ action: 'ledgerEntry.reversed', targetId: original._id })).toBe(1);
    });

    it('still works after an account in the entry is deactivated', async () => {
      const original = await post(capitalIntoBank);
      await LedgerAccount.updateOne({ _id: CAPITAL }, { $set: { isActive: false } });
      expect((await reverse(original._id)).reversalOf).toBe(original._id);
    });

    it('refuses a second reversal, reversing a reversal, and an unknown entry', async () => {
      const original = await post(capitalIntoBank);
      const reversal = await reverse(original._id);

      expect(await refusal(() => reverse(original._id))).toMatchObject({ status: 409, code: 'entry_already_reversed' });
      expect(await refusal(() => reverse(reversal._id))).toMatchObject({ status: 409, code: 'entry_is_a_reversal' });
      expect(await refusal(() => reverse('le_missing'))).toMatchObject({ status: 404, code: 'unknown_ledger_entry' });
      expect(await LedgerEntry.countDocuments()).toBe(2);
    });

    it('lets only one of two reversals made at the same time succeed', async () => {
      const original = await post(capitalIntoBank);
      const results = await Promise.allSettled([reverse(original._id), reverse(original._id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await LedgerEntry.countDocuments({ reversalOf: original._id })).toBe(1);
    });
  });

  describe('trial balance', () => {
    it('is empty and balanced before anything is posted', async () => {
      expect(await getTrialBalance()).toEqual({ rows: [], totalDebit: 0, totalCredit: 0, difference: 0 });
    });

    it('balances after an entry, and every account nets to zero after its reversal', async () => {
      const original = await post(capitalIntoBank);

      const afterEntry = await getTrialBalance();
      expect(afterEntry).toMatchObject({ totalDebit: 5_000_000, totalCredit: 5_000_000, difference: 0 });
      expect(afterEntry.rows.map(({ code, balance }) => [code, balance])).toEqual([['1200', 5_000_000], ['3100', -5_000_000]]);

      await reverse(original._id);

      const afterReversal = await getTrialBalance();
      expect(afterReversal).toMatchObject({ totalDebit: 10_000_000, totalCredit: 10_000_000, difference: 0 });
      expect(afterReversal.rows.every((row) => row.balance === 0)).toBe(true);
    });

    it('leaves out entries dated after the date asked for', async () => {
      await post(capitalIntoBank);
      await post({ entryDate: '2026-11-20', memo: 'Rent', source: { type: 'bill', id: 'bill_1' }, lines: [{ accountId: RENT, debit: 1_000 }, { accountId: BANK, credit: 1_000 }] });

      const early = await getTrialBalance('2026-11-02');
      expect(early.rows.map((row) => row.code)).toEqual(['1200', '3100']);
      expect(early.totalDebit).toBe(5_000_000);
      expect((await getTrialBalance('2026-11-01')).rows).toEqual([]);
    });
  });
});
