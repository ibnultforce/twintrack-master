import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import type { PageRequest } from '../../../lib/query.js';
import type { RecordFields } from '../../../lib/records/recordFields.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { fieldRulesFor, invalidField, readRecordHistory, roundMoney, writeAccountsRecord, type ActiveStatus, type Currency } from '../accountsModule.js';
import { endOfDay, findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { BankAccount, COMPANY_BANK_DETAILS_ID, CompanyBankDetails, type BankAccountDoc, type CompanyBankDetailsDoc } from '../models/masterData.js';
import { findBankMovements, sumBankMovements } from './bankBalance.repository.js';

const RESOURCE = 'bankAccount';
const DETAILS_RESOURCE = 'companyBankDetails';
/** A statement lists at most this many movements, so a long period can't make an answer too big to send. */
const MAX_STATEMENT_ENTRIES = 2000;

export /** Money is dated by day, so an account counts everything from the start of its opening day. */
const startOfDay = (moment: Date) => new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()));

export const bankAccountNotFound = () => new ApiError(404, 'unknown_bank_account', 'No such bank account.');

export interface BankAccountDetails {
  name: string;
  bankName?: string;
  accountNumber?: string;
  currency: Currency;
  openingBalance?: number;
  openingDate?: Date;
}

export type BankAccountChanges = Partial<Omit<BankAccountDetails, 'currency'>> & { status?: ActiveStatus; version?: number };

/** An account money can move through now, returned so callers can match its currency. */
export async function requireActiveBankAccount(bankAccountId: string, path = 'bankAccountId'): Promise<BankAccountDoc> {
  const account = await BankAccount.findById(bankAccountId).lean();
  if (!account) throw invalidField(path, 'no such bank account');
  if (account.status !== 'active') throw invalidField(path, 'is inactive');
  return account;
}

export type CompanyBankDetailsFields = Partial<Omit<CompanyBankDetailsDoc, '_id' | keyof RecordFields>>;

/**
 * The company's bank accounts, and the payment details printed on invoices. An account's currency never changes,
 * because every payment and receipt through it is in that currency.
 */
export function createBankAccountService(cipher: SecretCipher) {
  const toView = (account: BankAccountDoc, rules: FieldRules, movementTotal: number) =>
    redactRecord(
      {
        id: account._id,
        name: account.name,
        bankName: account.bankName,
        accountNumber: account.accountNumberEncrypted ? cipher.decrypt(account.accountNumberEncrypted) : undefined,
        currency: account.currency,
        openingBalance: account.openingBalance,
        openingDate: account.openingDate,
        // Opening balance plus everything posted since. Never typed in, so it can't drift from the records.
        currentBalance: roundMoney(account.openingBalance + movementTotal),
        status: account.status,
        version: account.version,
        createdBy: account.createdBy,
        createdAt: account.createdAt,
        updatedBy: account.updatedBy,
        updatedAt: account.updatedAt,
      },
      rules,
    );

  function toStored({ accountNumber, ...plain }: Partial<BankAccountDetails>) {
    if (accountNumber === undefined) return { $set: plain };
    return accountNumber ? { $set: { ...plain, accountNumberEncrypted: cipher.encrypt(accountNumber) } } : { $set: plain, $unset: { accountNumberEncrypted: 1 } };
  }

  async function viewWithBalance(actor: Actor, account: BankAccountDoc) {
    const totals = await sumBankMovements([account._id], { from: startOfDay(account.openingDate) });
    return toView(account, await fieldRulesFor(actor, RESOURCE), totals.get(account._id) ?? 0);
  }

  async function listBankAccounts(actor: Actor, query: PageRequest & { status?: ActiveStatus }) {
    const { status, ...page } = query;
    const { records, total } = await findRecordPage(BankAccount, { ...(status && { status }) }, page, { name: 1 });
    const rules = await fieldRulesFor(actor, RESOURCE);
    // Each account counts only what moved on or after its own opening date.
    const totals = await Promise.all(records.map((account) => sumBankMovements([account._id], { from: startOfDay(account.openingDate) })));
    return { total, bankAccounts: records.map((account, index) => toView(account, rules, totals[index]!.get(account._id) ?? 0)) };
  }

  async function getBankAccount(actor: Actor, bankAccountId: string) {
    return viewWithBalance(actor, await requireRecord(BankAccount, bankAccountId, bankAccountNotFound));
  }

  async function createBankAccount(actor: Actor, details: BankAccountDetails) {
    const rules = await fieldRulesFor(actor, RESOURCE);
    assertMayWriteFields(rules, Object.keys(details), 'create');
    const record = { _id: `ba_${randomUUID()}`, ...toStored(details).$set, openingBalance: details.openingBalance ?? 0, openingDate: details.openingDate ?? startOfDay(new Date()) };
    const created = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'bankAccount.created',
      write: (session) => insertRecord<BankAccountDoc>(BankAccount, record, actor.user._id, session),
      label: (account) => account.name,
    });
    return viewWithBalance(actor, created);
  }

  async function updateBankAccount(actor: Actor, bankAccountId: string, changes: BankAccountChanges) {
    const { version, status, ...details } = changes;
    const existing = await requireRecord(BankAccount, bankAccountId, bankAccountNotFound);
    assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys({ ...details, ...(status && { status }) }), 'update');
    const stored = toStored(details);
    const saved = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: status && status !== existing.status ? `bankAccount.${status === 'active' ? 'reactivated' : 'deactivated'}` : 'bankAccount.updated',
      before: existing,
      write: (session) =>
        changeRecord(BankAccount, bankAccountId, { ...stored, $set: { ...stored.$set, ...(status && { status }) } }, { actorId: actor.user._id, expectedVersion: version, session }, bankAccountNotFound),
      label: (account) => account.name,
    });
    return viewWithBalance(actor, saved);
  }

  /** Every movement in the period, with the balance before it and after each one. */
  async function getStatement(bankAccountId: string, period: { from: Date; to: Date }) {
    const account = await requireRecord(BankAccount, bankAccountId, bankAccountNotFound);
    const opened = startOfDay(account.openingDate);
    const start = period.from < opened ? opened : period.from;
    const before = endOfDay(period.to);
    const [earlier, movements] = await Promise.all([
      sumBankMovements([bankAccountId], { from: opened, before: start }),
      findBankMovements([bankAccountId], { from: start, before }),
    ]);
    if (movements.length > MAX_STATEMENT_ENTRIES) {
      throw new ApiError(422, 'period_too_long', `This period has more than ${MAX_STATEMENT_ENTRIES} movements. Ask for a shorter one.`);
    }
    const openingBalance = roundMoney(account.openingBalance + (earlier.get(bankAccountId) ?? 0));
    let balance = openingBalance;
    const entries = movements.map(({ bankAccountId: _account, ...movement }) => {
      balance = roundMoney(balance + movement.amount);
      return { ...movement, balance };
    });
    return { bankAccountId, currency: account.currency, from: start, to: period.to, openingBalance, closingBalance: balance, entries };
  }

  async function getBankAccountHistory(actor: Actor, bankAccountId: string, page: PageRequest) {
    await requireRecord(BankAccount, bankAccountId, bankAccountNotFound);
    return readRecordHistory(actor, RESOURCE, bankAccountId, page);
  }

  const toDetailsView = (details: CompanyBankDetailsDoc | null, rules: FieldRules) =>
    redactRecord(
      {
        bankName: details?.bankName,
        accountName: details?.accountName,
        accountNumber: details?.accountNumber,
        branchName: details?.branchName,
        routingNumber: details?.routingNumber,
        swiftCode: details?.swiftCode,
        address: details?.address,
        version: details?.version ?? 0,
        updatedBy: details?.updatedBy,
        updatedAt: details?.updatedAt,
      },
      rules,
    );

  async function getCompanyBankDetails(actor: Actor) {
    return toDetailsView(await CompanyBankDetails.findById(COMPANY_BANK_DETAILS_ID).lean(), await fieldRulesFor(actor, DETAILS_RESOURCE));
  }

  /** Saves the details given. The first save creates them. */
  async function saveCompanyBankDetails(actor: Actor, request: CompanyBankDetailsFields & { version?: number }) {
    const { version, ...fields } = request;
    const rules = await fieldRulesFor(actor, DETAILS_RESOURCE);
    const existing = await CompanyBankDetails.findById(COMPANY_BANK_DETAILS_ID).lean();
    assertMayWriteFields(rules, Object.keys(fields), existing ? 'update' : 'create');
    // Fields left out stay as they are, and an empty one is cleared, so nobody clears a field they can't edit.
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    const cleared = Object.fromEntries(Object.entries(fields).filter(([, value]) => !value).map(([field]) => [field, 1]));
    const saved = await writeAccountsRecord(actor, {
      resource: DETAILS_RESOURCE,
      auditAction: 'companyBankDetails.updated',
      before: existing ?? undefined,
      write: (session) =>
        existing
          ? changeRecord(CompanyBankDetails, COMPANY_BANK_DETAILS_ID, { $set: set, $unset: cleared }, { actorId: actor.user._id, expectedVersion: version, session }, () => new ApiError(404, 'no_details', 'No company bank details.'))
          : insertRecord<CompanyBankDetailsDoc>(CompanyBankDetails, { _id: COMPANY_BANK_DETAILS_ID, ...set }, actor.user._id, session),
      label: () => 'Company bank details',
    });
    return toDetailsView(saved, rules);
  }

  return { listBankAccounts, getBankAccount, createBankAccount, updateBankAccount, getStatement, getBankAccountHistory, getCompanyBankDetails, saveCompanyBankDetails };
}

export async function readCompanyBankDetails(): Promise<CompanyBankDetailsDoc | null> {
  return CompanyBankDetails.findById(COMPANY_BANK_DETAILS_ID).lean();
}
