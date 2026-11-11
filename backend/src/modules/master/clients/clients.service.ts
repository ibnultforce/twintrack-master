import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { ClientDoc, ClientStatus } from '../models/client.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../records/recordHistory.service.js';
import {
  clientNotFound,
  findClientById,
  findClientsPage,
  insertClient,
  updateClient as saveClientChanges,
  type ClientChanges,
  type NewClientRecord,
} from './clients.repository.js';

const CLIENT_RESOURCE = 'client';

export type NewClientDetails = Omit<NewClientRecord, '_id'>;

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, MASTER_MODULE_KEY, CLIENT_RESOURCE);
const historyRef = (clientId: string) => ({ module: MASTER_MODULE_KEY, object: CLIENT_RESOURCE, recordId: clientId });

/** The client as this person may see it: fields they have no access to are left out. */
function toClientView(client: ClientDoc, rules: FieldRules) {
  return redactRecord(
    {
      id: client._id,
      name: client.name,
      initials: client.initials,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      address: client.address,
      notes: client.notes,
      status: client.status,
      version: client.version,
      createdBy: client.createdBy,
      createdAt: client.createdAt,
      updatedBy: client.updatedBy,
      updatedAt: client.updatedAt,
    },
    rules,
  );
}

const clientAuditFields = (actor: Actor, client: ClientDoc) => ({
  ...actorFields(actor),
  targetType: CLIENT_RESOURCE,
  targetId: client._id,
  targetName: client.name,
});

/** Initials appear in invoice numbers, so two clients may not share them. */
async function withUniqueInitials<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'initials_taken', 'Another client already uses those initials.');
    throw error;
  }
}

async function requireClient(clientId: string): Promise<ClientDoc> {
  const client = await findClientById(clientId);
  if (!client) throw clientNotFound();
  return client;
}

export async function listClients(actor: Actor, query: PageRequest & { search?: string; status?: ClientStatus }) {
  const { clients, total } = await findClientsPage(query);
  const rules = await fieldRulesFor(actor);
  return { clients: clients.map((client) => toClientView(client, rules)), total };
}

export async function getClient(actor: Actor, clientId: string) {
  return toClientView(await requireClient(clientId), await fieldRulesFor(actor));
}

export async function createClient(actor: Actor, details: NewClientDetails) {
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');

  const client = await withUniqueInitials(() =>
    runInTransaction(async (session) => {
      const created = await insertClient({ ...details, _id: `cl_${randomUUID()}` }, actor.user._id, session);
      await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
      await recordAudit({ action: 'client.created', ...clientAuditFields(actor, created) }, session);
      return created;
    }),
  );
  return toClientView(client, rules);
}

/** Saves changes to a client. Making one inactive keeps it on old records but out of lists for new work. */
export async function updateClient(actor: Actor, clientId: string, changes: ClientChanges & { version?: number }) {
  const { version, ...fields } = changes;
  const existing = await requireClient(clientId);
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(fields), 'update');

  const auditAction = fields.status && fields.status !== existing.status ? `client.${fields.status === 'active' ? 'reactivated' : 'deactivated'}` : 'client.updated';
  const saved = await withUniqueInitials(() =>
    runInTransaction(async (session) => {
      const result = await saveClientChanges(clientId, fields, { actorId: actor.user._id, expectedVersion: version, session });
      await writeRecordHistory(historyRef(clientId), { action: 'updated', actor, before: existing, after: result }, session);
      await recordAudit({ action: auditAction, ...clientAuditFields(actor, result) }, session);
      return result;
    }),
  );
  return toClientView(saved, rules);
}

export async function getClientHistory(actor: Actor, clientId: string, page: PageRequest) {
  await requireClient(clientId);
  const history = await listRecordHistory(historyRef(clientId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}
