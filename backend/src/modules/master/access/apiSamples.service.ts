import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import type { ApiExample, ApiGuide, ReferenceChoice } from '../../../lib/apiExamples.js';
import { findBodySchema } from '../../../lib/apiRoute.js';
import { listBodyFields } from '../../../lib/bodyFieldOptions.js';

/**
 * Turns the test page's samples into ones that work against this database. Samples name records from the example
 * data, such as "u_04" or a projectId an earlier step makes, which don't exist here. Each one is swapped for a real
 * record of the same kind, and a sample that creates something gets a fresh name and email, so it doesn't clash with
 * a record that already exists.
 *
 * Collections are found by model name, so Master reads only record ids and never imports another module's code.
 */

interface RecordSource {
  model: string;
  filter?: Record<string, unknown>;
}

// Example-data ids by prefix. Ids ending in "_nowhere" stay as they are: those samples are meant to find nothing.
const FIXTURE_ID = /\b(u|or|s)_(?!nowhere\b)[a-z0-9_]+\b/g;
const WHOLE_FIXTURE_ID = new RegExp(`^${FIXTURE_ID.source}$`);
const FIXTURE_SOURCES: Record<string, RecordSource> = {
  u: { model: 'User', filter: { status: 'active', superAdmin: { $ne: true } } },
  or: { model: 'OrgRole' },
  s: { model: 'Salary' },
};

// Values an earlier step makes in the example data, and where to find a real one instead.
const STEP_VALUE_SOURCES: Record<string, RecordSource> = {
  profileId: { model: 'AccessProfile' },
  clientId: { model: 'Client' },
  tokenId: { model: 'ApiToken' },
  orgRoleId: { model: 'OrgRole' },
  shareId: { model: 'RecordShare' },
  recordId: { model: 'CustomRecord' },
  projectId: { model: 'Project' },
  taskId: { model: 'Task' },
  otherTaskId: { model: 'Task' },
  attachmentId: { model: 'TaskAttachment' },
  credentialId: { model: 'ProjectCredential' },
  vendorId: { model: 'AccountsVendor' },
};

// Body fields that always name one kind of record, for fields a sample doesn't set, such as leadId on a project.
// Names that mean different records in different APIs, such as parentId or granteeId, are left out.
const PERSON: RecordSource = FIXTURE_SOURCES.u!;
const FIELD_SOURCES: Record<string, { source: RecordSource; isMany: boolean }> = {
  leadId: { source: PERSON, isMany: false },
  managerId: { source: PERSON, isMany: false },
  employeeId: { source: PERSON, isMany: false },
  assignedDevId: { source: PERSON, isMany: false },
  qaId: { source: PERSON, isMany: false },
  userId: { source: PERSON, isMany: false },
  memberIds: { source: PERSON, isMany: true },
  userIds: { source: PERSON, isMany: true },
  orgRoleId: { source: FIXTURE_SOURCES.or!, isMany: false },
  profileId: { source: STEP_VALUE_SOURCES.profileId!, isMany: false },
  clientId: { source: STEP_VALUE_SOURCES.clientId!, isMany: false },
  projectId: { source: STEP_VALUE_SOURCES.projectId!, isMany: false },
  taskIds: { source: STEP_VALUE_SOURCES.taskId!, isMany: true },
  vendorId: { source: STEP_VALUE_SOURCES.vendorId!, isMany: false },
};

/** Pickers for id fields the API's body schema names but the sample leaves out. */
function choicesFromSchema(api: string, taken: ReferenceChoice[]): ReferenceChoice[] {
  const schema = findBodySchema(api);
  if (!schema) return [];
  return listBodyFields(schema).flatMap((field) => {
    const known = FIELD_SOURCES[field];
    if (!known || taken.some((choice) => choice.location === 'body' && choice.field === field)) return [];
    return [{ field, location: 'body' as const, list: listName(known.source), isMany: known.isMany }];
  });
}

const UNIQUE_TAG_BYTES = 3;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const PLACEHOLDER_NAME = /^\{\{(\w+)\}\}$/;

/** One record a value can be chosen from, as the Try dialog lists it. */
export interface ReferenceOption {
  id: string;
  label: string;
}

type IdPool = Map<string, string[]>;
type ReferenceLists = Record<string, ReferenceOption[]>;

// Enough to choose from without sending whole collections. The first ones are also used to fill samples.
const OPTIONS_PER_LIST = 100;
const LABEL_FIELDS = 'name title label key number email';

const sourceKey = ({ model, filter }: RecordSource) => `${model}:${JSON.stringify(filter ?? {})}`;
// The list a value is chosen from is named after its kind of record, such as User.
const listName = (source: RecordSource) => source.model;

interface LabelledRecord {
  _id: unknown;
  name?: string;
  title?: string;
  label?: string;
  key?: string;
  number?: string | number;
  email?: string;
}

function labelOf(record: LabelledRecord): string {
  const id = String(record._id);
  const name = record.name ?? record.title ?? record.label ?? record.key ?? (record.number === undefined ? undefined : String(record.number));
  if (!name) return id;
  return record.email ? `${name} (${record.email})` : name;
}

async function loadRecords(sources: RecordSource[]): Promise<{ pool: IdPool; lists: ReferenceLists }> {
  const pool: IdPool = new Map();
  const lists: ReferenceLists = {};
  await Promise.all(sources.map(async (source) => {
    const key = sourceKey(source);
    if (pool.has(key)) return;
    pool.set(key, []);
    // A module that isn't part of this build has no model, so its samples keep the example values.
    const model = mongoose.models[source.model];
    if (!model) return;
    const records = await model.find(source.filter ?? {}).select(LABEL_FIELDS).sort({ createdAt: 1, _id: 1 }).limit(OPTIONS_PER_LIST).lean<LabelledRecord[]>();
    pool.set(key, records.map((record) => String(record._id)));
    lists[listName(source)] = records.map((record) => ({ id: String(record._id), label: labelOf(record) }));
  }));
  return { pool, lists };
}

/** Gives each example value its own real record of the right kind, the same one wherever it appears. */
class IdAssigner {
  private readonly assigned = new Map<string, string | null>();
  private readonly nextIndex = new Map<string, number>();

  constructor(private readonly pool: IdPool) {}

  realIdFor(exampleValue: string, source: RecordSource): string | null {
    const known = this.assigned.get(exampleValue);
    if (known !== undefined) return known;
    const key = sourceKey(source);
    const ids = this.pool.get(key) ?? [];
    const index = this.nextIndex.get(key) ?? 0;
    // Wraps round when the database has fewer records than the example names.
    const id = ids.length > 0 ? ids[index % ids.length]! : null;
    this.nextIndex.set(key, index + 1);
    this.assigned.set(exampleValue, id);
    return id;
  }
}

/** Fresh values for a record a sample creates, so the request doesn't clash with one that exists. */
function makeUnique(body: unknown, tag: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const fields = { ...(body as Record<string, unknown>) };
  if (typeof fields.email === 'string') fields.email = fields.email.replace('@', `+${tag}@`);
  if (typeof fields.name === 'string') fields.name = `${fields.name} ${tag}`;
  if (typeof fields.key === 'string') fields.key = `${fields.key}${tag}`;
  return fields;
}

function fillExample(example: ApiExample, method: string, assign: (value: string) => string | null, tag: string): ApiExample {
  const replaceFixtureIds = (text: string) => text.replace(FIXTURE_ID, (value) => assign(value) ?? value);
  const replaceStepValues = (text: string) => text.replace(PLACEHOLDER, (whole, name: string) => assign(`{{${name}}}`) ?? whole);
  const fillText = (text: string) => replaceStepValues(replaceFixtureIds(text));

  const parameters = Object.fromEntries(Object.entries(example.parameters).map(([name, value]) => {
    const source = example.parameterSources[name];
    return [name, source ? (assign(`{{${source}}}`) ?? '') : fillText(value)];
  }));
  let body = example.body ? fillText(example.body) : '';
  if (body && method === 'POST' && example.outcome === 'accepted') {
    try {
      body = JSON.stringify(makeUnique(JSON.parse(body), tag), null, 2);
    } catch {
      // A body that isn't JSON, such as a photo's bytes, is sent as it is.
    }
  }
  const stillNeeded = example.needs.filter((need) => assign(`{{${need.value}}}`) === null);
  return { ...example, parameters, query: fillText(example.query), body, needs: stillNeeded, choices: findChoices(example) };
}

const isReference = (value: unknown): value is string => typeof value === 'string' && sourceOf(value) !== undefined;

/** The body fields and path parameters of a sample that take a record's id, read from its example values. */
function findChoices(example: ApiExample): ReferenceChoice[] {
  const choices: ReferenceChoice[] = [];
  for (const [name, value] of Object.entries(example.parameters)) {
    const exampleValue = example.parameterSources[name] ? `{{${example.parameterSources[name]}}}` : value;
    const source = sourceOf(exampleValue);
    if (source) choices.push({ field: name, location: 'path', list: listName(source), isMany: false });
  }
  let body: unknown;
  try {
    body = example.body ? JSON.parse(example.body) : undefined;
  } catch {
    body = undefined;
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const [field, value] of Object.entries(body)) {
      const first = Array.isArray(value) ? value.find(isReference) : value;
      if (!isReference(first)) continue;
      choices.push({ field, location: 'body', list: listName(sourceOf(first)!), isMany: Array.isArray(value) });
    }
  }
  return choices;
}

function sourceOf(value: string): RecordSource | undefined {
  const step = PLACEHOLDER_NAME.exec(value)?.[1];
  if (step) return STEP_VALUE_SOURCES[step];
  if (!WHOLE_FIXTURE_ID.test(value)) return undefined;
  return FIXTURE_SOURCES[value.slice(0, value.indexOf('_'))];
}

/**
 * The same guides with samples that name real records in this database, and the records each id field can be chosen
 * from. For super admins, who may see every record.
 */
export async function fillGuidesFromDatabase(guides: Record<string, ApiGuide>): Promise<{ guides: Record<string, ApiGuide>; references: ReferenceLists }> {
  const { pool, lists } = await loadRecords([...Object.values(FIXTURE_SOURCES), ...Object.values(STEP_VALUE_SOURCES)]);
  const assigner = new IdAssigner(pool);
  const assign = (value: string) => {
    const source = sourceOf(value);
    return source ? assigner.realIdFor(value, source) : null;
  };
  const tag = randomBytes(UNIQUE_TAG_BYTES).toString('hex');

  const filled = Object.fromEntries(Object.entries(guides).map(([api, guide]) => {
    const method = api.slice(0, api.indexOf(' '));
    const examples = guide.examples.map((example) => {
      const filled = fillExample(example, method, assign, tag);
      const choices = filled.choices ?? [];
      return { ...filled, choices: [...choices, ...choicesFromSchema(api, choices)] };
    });
    return [api, { ...guide, examples }];
  }));
  return { guides: filled, references: lists };
}
