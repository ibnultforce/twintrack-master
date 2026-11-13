import { readFileSync } from 'node:fs';
import { findBodySchema } from './apiRoute.js';
import { listBodyFieldOptions, type BodyFieldOption } from './bodyFieldOptions.js';

/**
 * Sample requests for each API, for the Try dialog on "Your permissions". They come from the test page's scenarios,
 * which tests require for every route and replay against the API, so the samples can't drift from what the API does.
 * Scenarios about the token itself, such as a missing or forged one, are left out: Try always sends your own.
 */

// The same depth from src/lib and dist/lib, so this finds backend/test-page in both.
const SCENARIOS_FILE = new URL('../../test-page/scenarios.json', import.meta.url);
const ACCOUNTS_FILE = new URL('../../test-page/accounts.json', import.meta.url);

const PATH_PARAMETER = /^:(\w+)$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{(\w+)\}\}$/;

interface ScenarioRequest {
  method: string;
  path: string;
  as?: string;
  body?: string;
  cookie?: string;
  literalToken?: string;
  origin?: string;
}

interface Scenario {
  kind: 'success' | 'fail';
  title: string;
  expected: number;
  code?: string;
  changesData?: boolean;
  setup?: { method: string; path: string; as?: string; save?: Record<string, string> }[];
  request: ScenarioRequest;
}

interface ScenarioRoute {
  id: string;
  purpose?: string;
  input?: string;
  scenarios: Scenario[];
}

/** A body field or path parameter that takes a record's id, and the list of records to choose it from. */
export interface ReferenceChoice {
  field: string;
  location: 'body' | 'path';
  list: string;
  /** The field holds a list of ids, such as memberIds. */
  isMany: boolean;
}

export interface ApiExample {
  title: string;
  /** Whether the API should accept it. */
  outcome: 'accepted' | 'refused';
  expectedStatus: number;
  expectedCode?: string;
  /** Who sends it in the example data, so the outcome matches their access, not necessarily yours. */
  sentBy?: string;
  /** Requests the example data sends first, as "METHOD /path", such as deleting a salary before restoring it. */
  sendFirst: string[];
  /** Values for the path's parameters. An empty one comes from an earlier step, named in needs. */
  parameters: Record<string, string>;
  /** For each empty parameter, the value from an earlier step it takes, such as id from projectId. */
  parameterSources: Record<string, string>;
  query: string;
  /** Pretty-printed JSON, or empty when the API takes no body. */
  body: string;
  /** Values the sample uses that an earlier request creates, such as a task id, with the request that makes them. */
  needs: { value: string; madeBy: string }[];
  changesData: boolean;
  /** Set for super admins: the fields that take a record's id. */
  choices?: ReferenceChoice[];
}

export interface ApiGuide {
  purpose?: string;
  input?: string;
  examples: ApiExample[];
  /** Body fields that take one of a fixed set of values, read from the schema the API checks its body with. */
  fieldOptions: BodyFieldOption[];
}

const prettyBody = (body: string | undefined) => {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

/** Reads each parameter's value from where the route's pattern has it in the sample's path. */
function readParameters(pattern: string, path: string): { parameters: Record<string, string>; parameterSources: Record<string, string> } {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  const parameters: Record<string, string> = {};
  const parameterSources: Record<string, string> = {};
  patternParts.forEach((part, index) => {
    const name = PATH_PARAMETER.exec(part)?.[1];
    if (!name) return;
    const value = decodeURIComponent(pathParts[index] ?? '');
    // A placeholder means the value comes from an earlier step, which differs every time.
    const source = WHOLE_PLACEHOLDER.exec(value)?.[1];
    parameters[name] = source ? '' : value;
    if (source) parameterSources[name] = source;
  });
  return { parameters, parameterSources };
}

function toExample(route: ScenarioRoute, scenario: Scenario, people: Map<string, string>): ApiExample | null {
  const { request } = scenario;
  if (!request.as || request.cookie || request.literalToken || request.origin) return null;
  const [path = '', query = ''] = request.path.split('?');
  const pattern = route.id.slice(route.id.indexOf(' ') + 1);
  const used = new Set([...`${request.path} ${request.body ?? ''}`.matchAll(PLACEHOLDER)].map((match) => match[1]!));
  const needs = [...used].map((value) => {
    const step = scenario.setup?.find((candidate) => candidate.save && value in candidate.save);
    return { value, madeBy: step ? `${step.method} ${step.path.split('?')[0]}` : 'an earlier request' };
  });
  return {
    title: scenario.title,
    outcome: scenario.kind === 'success' ? 'accepted' : 'refused',
    expectedStatus: scenario.expected,
    ...(scenario.code && { expectedCode: scenario.code }),
    sentBy: people.get(request.as),
    sendFirst: (scenario.setup ?? []).map((step) => `${step.method} ${step.path.split('?')[0]}`),
    ...readParameters(pattern, path),
    query,
    body: prettyBody(request.body),
    needs,
    changesData: Boolean(scenario.changesData),
  };
}

function loadGuides(): Map<string, ApiGuide> {
  const { groups } = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')) as { groups: { routes: ScenarioRoute[] }[] };
  // Only names: what each person may do depends on the profiles a scenario's data gives them, which titles describe.
  const { accounts } = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) as { accounts: { email: string; name: string }[] };
  const people = new Map(accounts.map((account) => [account.email, account.name]));
  const guides = new Map<string, ApiGuide>();
  for (const route of groups.flatMap((group) => group.routes)) {
    const examples = route.scenarios.map((scenario) => toExample(route, scenario, people)).filter((example): example is ApiExample => example !== null);
    // Accepted samples first, since they show how the API is meant to be used.
    examples.sort((first, second) => Number(first.outcome === 'refused') - Number(second.outcome === 'refused'));
    guides.set(route.id, { purpose: route.purpose, input: route.input, examples, fieldOptions: [] });
  }
  return guides;
}

let cachedGuides: Map<string, ApiGuide> | undefined;

/** The guide for each of these APIs, as "METHOD /path". An API without scenarios gets none. */
export function findApiGuides(apis: string[]): Record<string, ApiGuide> {
  cachedGuides ??= loadGuides();
  const guides = cachedGuides;
  return Object.fromEntries(apis.flatMap((api) => {
    const guide = guides.get(api);
    if (!guide) return [];
    // Read when asked, since routes register their schemas after this module loads.
    const schema = findBodySchema(api);
    return [[api, { ...guide, fieldOptions: schema ? listBodyFieldOptions(schema) : [] }]];
  }));
}
