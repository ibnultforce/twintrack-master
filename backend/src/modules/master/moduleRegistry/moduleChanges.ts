import { isDeepStrictEqual } from 'node:util';
import { isApiRegistered } from '../../../lib/apiRoute.js';
import type { DataModel, ManifestResource, ManifestRoute } from './manifest.js';

export type ModuleChangeKind = 'added' | 'removed' | 'changed';

/** One thing an import changed, and the places a developer has to work for the code to match it. */
export interface ModuleChangeItem {
  kind: ModuleChangeKind;
  /** What changed, such as "Route GET /demo/notes" or "Field Note.status". */
  subject: string;
  /** How it changed, when "added" or "removed" alone doesn't say. */
  detail?: string;
  /** Repo paths and screens to update, in the order a developer would usually work through them. */
  where: string[];
}

/** The parts of a module an import can change. Any of them may be missing, for a module that didn't exist. */
export interface ModuleShape {
  baseUrl?: string;
  resources?: ManifestResource[];
  routes?: ManifestRoute[];
  schema?: DataModel;
}

/** Resource settings that change how the backend checks access or writes records. */
const RESOURCE_SETTINGS = ['scoped', 'sharingModel', 'recordFields', 'protectedFields', 'trackedFields'] as const;

/** The JSON Schema keywords on a property that change what the API returns or accepts. */
const PROPERTY_KEYWORDS = ['type', 'enum', 'const', 'format', 'items', '$ref', 'minLength', 'maxLength', 'minimum', 'maximum', 'x-fieldAccess'] as const;

const codeFolder = (key: string) => `backend/src/modules/${key}/`;
const apiDoc = (key: string) => `docs/api/${key}.md`;
const POSTMAN = 'postman/twintrack-master.postman_collection.json';
const SCENARIOS = 'backend/test-page/scenarios.json';

const joinPath = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, '')}${path === '/' ? '' : path}` || '/';
const routeLabel = (baseUrl: string, route: ManifestRoute) => `${route.method} ${joinPath(baseUrl, route.path)}`;
const routeId = (route: ManifestRoute) => `${route.method} ${route.path}`;

function describeAccess(route: ManifestRoute): string {
  if (route.permission) return `${route.access}, ${route.permission}`;
  if (route.anyPermission) return `${route.access}, any of ${route.anyPermission.join(', ')}`;
  return route.access;
}

const listOrNone = (values: readonly unknown[] | undefined) => (values && values.length > 0 ? values.join(', ') : 'none');
const describeSetting = (value: unknown) => (Array.isArray(value) ? listOrNone(value) : value === undefined ? 'not set' : String(value));

function byKey<T>(items: T[] | undefined, keyOf: (item: T) => string): Map<string, T> {
  return new Map((items ?? []).map((item) => [keyOf(item), item]));
}

function diffRoutes(key: string, before: ModuleShape, after: ModuleShape): ModuleChangeItem[] {
  const baseUrl = after.baseUrl ?? before.baseUrl ?? `/${key}`;
  const describedIn = [POSTMAN, SCENARIOS, apiDoc(key)];
  const oldRoutes = byKey(before.routes, routeId);
  const newRoutes = byKey(after.routes, routeId);
  const items: ModuleChangeItem[] = [];

  const oldBaseUrl = before.baseUrl ?? `/${key}`;
  if (before.routes && after.baseUrl && after.baseUrl !== oldBaseUrl) {
    items.push({
      kind: 'changed',
      subject: 'Base URL',
      detail: `${oldBaseUrl} → ${after.baseUrl}: every route of the module moves`,
      where: [`${codeFolder(key)} (every path in the module's routes list)`, ...describedIn, `the ${key} frontend`],
    });
  }

  for (const [id, route] of newRoutes) {
    const label = routeLabel(baseUrl, route);
    const previous = oldRoutes.get(id);
    if (!previous) {
      const hasCode = isApiRegistered(label);
      items.push({
        kind: 'added',
        subject: `Route ${label}`,
        detail: `${describeAccess(route)}${hasCode ? '' : '. No backend code serves it yet'}`,
        where: hasCode ? describedIn : [`${codeFolder(key)} (handler, and the route in the module's routes list)`, ...describedIn],
      });
    } else if (describeAccess(previous) !== describeAccess(route) || previous.planned !== route.planned) {
      items.push({
        kind: 'changed',
        subject: `Route ${label}`,
        detail: `access ${describeAccess(previous)} → ${describeAccess(route)}${previous.planned !== route.planned ? `, planned ${Boolean(previous.planned)} → ${Boolean(route.planned)}` : ''}`,
        where: [`${codeFolder(key)} (the route's declaration in the module's routes list)`, ...describedIn],
      });
    }
  }
  for (const [id, route] of oldRoutes) {
    if (newRoutes.has(id)) continue;
    const label = routeLabel(baseUrl, route);
    const hasCode = isApiRegistered(label);
    items.push({
      kind: 'removed',
      subject: `Route ${label}`,
      ...(hasCode && { detail: 'The backend still serves it' }),
      where: hasCode ? [`${codeFolder(key)} (remove the handler and its route)`, ...describedIn] : describedIn,
    });
  }
  return items;
}

function diffResources(key: string, before: ModuleShape, after: ModuleShape): ModuleChangeItem[] {
  // Custom objects are built in the app and kept by every import, so they never need code.
  const isFileResource = (resource: ManifestResource) => resource.custom !== true;
  const oldResources = byKey(before.resources?.filter(isFileResource), (resource) => resource.key);
  const newResources = byKey(after.resources?.filter(isFileResource), (resource) => resource.key);
  const services = `${codeFolder(key)} (services that check its permissions)`;
  const items: ModuleChangeItem[] = [];

  for (const [resourceKey, resource] of newResources) {
    const permission = `${key}.${resourceKey}`;
    const previous = oldResources.get(resourceKey);
    if (!previous) {
      items.push({
        kind: 'added',
        subject: `Resource ${permission}`,
        detail: `actions ${listOrNone(resource.actions)}`,
        where: [services, apiDoc(key), 'Profiles screen (only a super admin holds it until a profile grants it)'],
      });
      continue;
    }
    const addedActions = resource.actions.filter((action) => !previous.actions.includes(action));
    const removedActions = previous.actions.filter((action) => !resource.actions.includes(action));
    if (addedActions.length > 0 || removedActions.length > 0) {
      const parts = [addedActions.length > 0 ? `added ${addedActions.join(', ')}` : '', removedActions.length > 0 ? `removed ${removedActions.join(', ')}` : ''];
      items.push({
        kind: 'changed',
        subject: `Actions of ${permission}`,
        detail: parts.filter(Boolean).join('; '),
        where: [services, apiDoc(key), 'Profiles screen (tick or untick the actions)'],
      });
    }
    for (const setting of RESOURCE_SETTINGS) {
      if (isDeepStrictEqual(previous[setting], resource[setting])) continue;
      items.push({
        kind: 'changed',
        subject: `${setting} of ${permission}`,
        detail: `${describeSetting(previous[setting])} → ${describeSetting(resource[setting])}`,
        where: [`${codeFolder(key)} (record writes, field checks and redaction)`, apiDoc(key)],
      });
    }
  }
  for (const [resourceKey] of oldResources) {
    if (newResources.has(resourceKey)) continue;
    items.push({
      kind: 'removed',
      subject: `Resource ${key}.${resourceKey}`,
      where: [`${codeFolder(key)} (anything that still checks it)`, apiDoc(key), 'Profiles screen (profiles that granted it lose it)'],
    });
  }
  return items;
}

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {});
const requiredOf = (definition: JsonObject) => (Array.isArray(definition.required) ? (definition.required as string[]) : []);

function describeProperty(property: JsonObject): string {
  const parts = PROPERTY_KEYWORDS.filter((keyword) => property[keyword] !== undefined).map((keyword) => `${keyword} ${JSON.stringify(property[keyword])}`);
  return parts.join(', ') || 'any value';
}

function diffSchema(key: string, before: ModuleShape, after: ModuleShape): ModuleChangeItem[] {
  // A manifest import without a schema keeps the module's schema, so there's nothing to compare.
  if (!after.schema) return [];
  const oldDefinitions = asObject(before.schema?.$defs);
  const newDefinitions = asObject(after.schema.$defs);
  const where = (definitionName: string) => [
    `${codeFolder(key)}models/ (the stored record)`,
    `${codeFolder(key)} (responses and request bodies that carry ${definitionName})`,
    apiDoc(key),
    `module-packs/${key}/DATA_MODEL.md`,
    `the ${key} frontend`,
  ];
  const items: ModuleChangeItem[] = [];

  for (const [name, rawDefinition] of Object.entries(newDefinitions)) {
    if (!Object.hasOwn(oldDefinitions, name)) {
      items.push({ kind: 'added', subject: `Definition ${name}`, where: where(name) });
      continue;
    }
    const oldDefinition = asObject(oldDefinitions[name]);
    const newDefinition = asObject(rawDefinition);
    const oldProperties = asObject(oldDefinition.properties);
    const newProperties = asObject(newDefinition.properties);
    const oldRequired = requiredOf(oldDefinition);
    const newRequired = requiredOf(newDefinition);

    for (const [field, rawProperty] of Object.entries(newProperties)) {
      const property = asObject(rawProperty);
      const isRequired = newRequired.includes(field);
      if (!Object.hasOwn(oldProperties, field)) {
        items.push({ kind: 'added', subject: `Field ${name}.${field}`, detail: `${describeProperty(property)}${isRequired ? ', always present' : ''}`, where: where(name) });
        continue;
      }
      const previous = asObject(oldProperties[field]);
      const changes: string[] = [];
      if (describeProperty(previous) !== describeProperty(property)) changes.push(`${describeProperty(previous)} → ${describeProperty(property)}`);
      if (oldRequired.includes(field) !== isRequired) changes.push(isRequired ? 'now always present' : 'no longer always present');
      if (changes.length > 0) items.push({ kind: 'changed', subject: `Field ${name}.${field}`, detail: changes.join('; '), where: where(name) });
    }
    for (const field of Object.keys(oldProperties)) {
      if (!Object.hasOwn(newProperties, field)) items.push({ kind: 'removed', subject: `Field ${name}.${field}`, where: where(name) });
    }
    // A required field with no property is a mistake in the schema, worth fixing before anyone builds from it.
    const undefinedRequired = newRequired.filter((field) => !Object.hasOwn(newProperties, field) && !Object.hasOwn(newDefinition, 'allOf'));
    if (undefinedRequired.length > 0) {
      items.push({
        kind: 'changed',
        subject: `Definition ${name}`,
        detail: `"required" names fields it doesn't define: ${undefinedRequired.join(', ')}`,
        where: [`manifests/${key}.schema.json`],
      });
    }
  }
  for (const name of Object.keys(oldDefinitions)) {
    if (!Object.hasOwn(newDefinitions, name)) items.push({ kind: 'removed', subject: `Definition ${name}`, where: where(name) });
  }
  return items;
}

/** Everything that differs between a module before and after an import, with where each change needs work. */
export function diffModule(key: string, before: ModuleShape | null, after: ModuleShape): ModuleChangeItem[] {
  const previous = before ?? {};
  const routeAndResourceChanges = after.resources || after.routes ? [...diffResources(key, previous, after), ...diffRoutes(key, previous, after)] : [];
  return [...routeAndResourceChanges, ...diffSchema(key, previous, after)];
}
