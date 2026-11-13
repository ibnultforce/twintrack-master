import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../db.js';
import { ApiError } from '../../lib/errors.js';
import type { PageRequest } from '../../lib/query.js';
import { actorFields, type Actor } from '../master/access/caller.js';
import { recordAudit } from '../master/audit/audit.repository.js';
import { User } from '../master/models/user.js';
import { readFieldRules, redactHistory, type FieldRules } from '../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory, type RecordRef } from '../master/records/recordHistory.service.js';

/** This module's key in the Master backend, matching manifests/accounts.manifest.json. */
export const ACCOUNTS_MODULE_KEY = 'accounts';

export const CURRENCIES = ['BDT', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const TRANSACTION_METHODS = ['bank_transfer', 'cash', 'mobile_banking', 'cheque', 'card'] as const;
export type TransactionMethod = (typeof TRANSACTION_METHODS)[number];

export const ACTIVE_STATUSES = ['active', 'inactive'] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

const CENTS = 100;
/** Money is kept to the cent. */
export const roundMoney = (amount: number) => Math.round(amount * CENTS) / CENTS;
/** Sums of money can be a fraction of a cent out, so comparisons allow for that. */
export const MONEY_TOLERANCE = 0.005;

export const invalidField = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

export const recordRef = (object: string, recordId: string): RecordRef => ({ module: ACCOUNTS_MODULE_KEY, object, recordId });

export const fieldRulesFor = (actor: Actor, resource: string): Promise<FieldRules> => readFieldRules(actor, ACCOUNTS_MODULE_KEY, resource);

/**
 * Whoever made a bill or payroll run can't approve or reject it, super admins included, so money always passes two
 * people. The same rule as approving your own work in Tasks.
 */
export function assertNotOwnRecord(actor: Actor, createdBy: string | undefined, what: string): void {
  if (createdBy === actor.user._id) throw new ApiError(403, 'own_record', `Someone other than whoever made this ${what} has to decide on it.`);
}

export async function findPeopleNames(peopleIds: (string | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(peopleIds.filter((id): id is string => Boolean(id)))];
  const people = await User.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(people.map((person) => [person._id, person.name]));
}

export async function assertPersonExists(path: string, personId: string): Promise<void> {
  if (!(await User.exists({ _id: personId }))) throw invalidField(path, 'no such person');
}

interface RecordWrite<Doc extends { _id: string }> {
  resource: string;
  auditAction: string;
  /** The record before the change. Missing for a new record. */
  before?: Doc;
  historyAction?: 'created' | 'updated' | 'deleted';
  write: (session: ClientSession) => Promise<Doc>;
  /** What the activity log calls the record, such as a bill number. */
  label: (doc: Doc) => string | undefined;
}

/** Makes a change inside a transaction already open, with its field history and activity log entry. */
export async function writeAccountsRecordIn<Doc extends { _id: string }>(actor: Actor, change: RecordWrite<Doc>, session: ClientSession): Promise<Doc> {
  const saved = await change.write(session);
  const action = change.historyAction ?? (change.before ? 'updated' : 'created');
  await writeRecordHistory(recordRef(change.resource, saved._id), { action, actor, before: change.before, after: saved }, session);
  await recordAudit(
    { action: change.auditAction, ...actorFields(actor), targetType: change.resource, targetId: saved._id, targetName: change.label(saved), module: ACCOUNTS_MODULE_KEY },
    session,
  );
  return saved;
}

/** Saves a change with its field history and activity log entry, all in one transaction. */
export function writeAccountsRecord<Doc extends { _id: string }>(actor: Actor, change: RecordWrite<Doc>): Promise<Doc> {
  return runInTransaction((session) => writeAccountsRecordIn(actor, change, session));
}

/** A record's history with fields the caller may not see left out. Callers check the record exists first. */
export async function readRecordHistory(actor: Actor, resource: string, recordId: string, page: PageRequest) {
  const history = await listRecordHistory(recordRef(resource, recordId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor, resource)) };
}
