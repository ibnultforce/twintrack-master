import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { findActiveClients, findClientById } from '../../master/clients/clients.repository.js';
import type { ClientDoc } from '../../master/models/client.js';
import { assertMayWriteFields, readFieldRules, redactRecord } from '../../master/records/fieldSecurity.service.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { ClientAccount, DEFAULT_TERMS_DAYS, type ClientAccountDoc } from '../models/clientAccount.js';
import { HOME_CURRENCY } from '../models/accountsSettings.js';
import { findDefaultCurrency } from '../settings/settings.service.js';
import { findOrCreateSettings } from '../settings/settings.repository.js';

const CLIENT_ACCOUNT_RESOURCE = 'clientAccount';

/** How a client is billed, with the defaults filled in for a client nobody has set up yet. */
export interface ClientBilling {
  clientId: string;
  clientName: string;
  termsDays: number;
  currency: string;
  /** Minor units of the currency per hour; missing until someone sets it. */
  hourlyRate?: number;
}

export interface ClientAccountChanges {
  termsDays?: number;
  currency?: string;
  /** null clears it. */
  hourlyRate?: number | null;
}

const clientAccountNotFound = () => new ApiError(404, 'unknown_client', 'No such client.');

const invalidField = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

const historyRef = (clientId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: CLIENT_ACCOUNT_RESOURCE, recordId: clientId });

function toBilling(client: Pick<ClientDoc, '_id' | 'name'>, account: ClientAccountDoc | null, defaultCurrency: string): ClientBilling {
  return {
    clientId: client._id,
    clientName: client.name,
    termsDays: account?.termsDays ?? DEFAULT_TERMS_DAYS,
    currency: account?.currency ?? defaultCurrency,
    ...(account?.hourlyRate !== undefined && { hourlyRate: account.hourlyRate }),
  };
}

/** How one client is billed, for invoices. Refuses a client that doesn't exist. */
export async function findClientBilling(clientId: string): Promise<ClientBilling> {
  const client = await findClientById(clientId);
  if (!client) throw clientAccountNotFound();
  const [account, defaultCurrency] = await Promise.all([ClientAccount.findById(clientId).lean(), findDefaultCurrency()]);
  return toBilling(client, account, defaultCurrency);
}

export async function listClientAccounts(actor: Actor) {
  const [clients, defaultCurrency, rules] = await Promise.all([findActiveClients(), findDefaultCurrency(), readFieldRules(actor, ACCOUNTS_MODULE_KEY, CLIENT_ACCOUNT_RESOURCE)]);
  const accounts = new Map((await ClientAccount.find({ _id: { $in: clients.map((client) => client._id) } }).lean()).map((account) => [account._id, account]));
  return {
    clients: clients.map((client) => {
      const account = accounts.get(client._id);
      return redactRecord({ ...toBilling(client, account ?? null, defaultCurrency), version: account?.version ?? 0 }, rules);
    }),
  };
}

/** Sets how a client is billed. The first change makes its record; the currency must be taka or one listed in Settings. */
export async function updateClientAccount(actor: Actor, clientId: string, request: ClientAccountChanges & { version?: number }) {
  const { version, ...changes } = request;
  const rules = await readFieldRules(actor, ACCOUNTS_MODULE_KEY, CLIENT_ACCOUNT_RESOURCE);
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  const client = await findClientById(clientId);
  if (!client) throw clientAccountNotFound();
  if (changes.currency && changes.currency !== HOME_CURRENCY) {
    const settings = await findOrCreateSettings();
    if (!settings.currencies.some((currency) => currency.code === changes.currency)) throw invalidField('currency', `${changes.currency} isn't one of the currencies in Settings`);
  }

  const saved = await runInTransaction(async (session) => {
    const before = await ClientAccount.findById(clientId).session(session).lean();
    if (!before) {
      await ClientAccount.create([{ _id: clientId, termsDays: DEFAULT_TERMS_DAYS, version: 0, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    }
    const $set = { ...(changes.termsDays !== undefined && { termsDays: changes.termsDays }), ...(changes.currency && { currency: changes.currency }), ...(typeof changes.hourlyRate === 'number' && { hourlyRate: changes.hourlyRate }) };
    const update = { $set, ...(changes.hourlyRate === null && { $unset: { hourlyRate: 1 } }) };
    const after = await changeRecord(ClientAccount, clientId, update, { actorId: actor.user._id, expectedVersion: version ?? before?.version ?? 0, session }, clientAccountNotFound);
    await writeRecordHistory(historyRef(clientId), { action: before ? 'updated' : 'created', actor, before: before ?? undefined, after }, session);
    await recordAudit({ action: 'clientAccount.updated', ...actorFields(actor), targetType: CLIENT_ACCOUNT_RESOURCE, targetId: clientId, targetName: client.name, module: ACCOUNTS_MODULE_KEY }, session);
    return after;
  });
  return redactRecord({ ...toBilling(client, saved, await findDefaultCurrency()), version: saved.version }, rules);
}
