import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CoreModuleError, importManifest } from '../src/modules/importManifest.js';
import { validateManifest, type Manifest } from '../src/modules/manifest.js';
import { Module } from '../src/models/module.js';
import { User } from '../src/models/user.js';
import { useTestDatabase } from './helpers/database.js';

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const messages = (raw: unknown): string => {
  const result = validateManifest(raw);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
};

const minimal = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  module: { key: 'demo', name: 'Demo', version: '1.0.0' },
  resources: [{ key: 'thing', label: 'Things', actions: ['read', 'approve'], grantable: ['approve'] }],
  routes: [{ method: 'GET', path: '/things', access: 'private', permission: 'thing.read' }],
  roles: [{ key: 'viewer', name: 'Viewer', grants: { thing: { actions: ['read'], scope: 'team' } } }],
  ...overrides,
});

const valid = (raw: unknown): Manifest => {
  const result = validateManifest(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};

describe('validateManifest', () => {
  it('accepts the real Master and HR manifests', () => {
    expect(validateManifest(readJson('../../access.manifest.json')).ok).toBe(true);
    expect(validateManifest(readJson('../../seed/manifests/hr.json')).ok).toBe(true);
  });

  it('reports every problem in the invalid sample at once', () => {
    const text = messages(readJson('./fixtures/manifest-invalid.json'));
    expect(text).toMatch(/module\.key/);
    expect(text).toMatch(/module\.version/);
    expect(text).toMatch(/resources\.0\.actions\.2/);
    expect(text).toMatch(/routes\.0: a private route needs a permission/);
    expect(text).toMatch(/"run\.create" is not an action/);
    expect(text).toMatch(/routes\.2\.method/);
    expect(text).toMatch(/Role "admin" is listed twice/);
  });

  it('rejects a grant of an action the resource does not have', () => {
    const roles = [{ key: 'bad', name: 'Bad', grants: { thing: { actions: ['delete'] } } }];
    expect(messages(minimal({ roles }))).toMatch(/"delete" is not an action of "thing"/);
  });

  it('rejects a grant on an unknown resource and an unknown scope', () => {
    const roles = [{ key: 'bad', name: 'Bad', grants: { ghost: { actions: ['read'], scope: 'department' } } }];
    const text = messages(minimal({ roles }));
    expect(text).toMatch(/"ghost" is not a resource/);
    expect(text).toMatch(/roles\.0\.grants\.ghost\.scope/);
  });

  it('rejects grantable actions the resource does not have', () => {
    const resources = [{ key: 'thing', label: 'Things', actions: ['read'], grantable: ['approve'] }];
    expect(messages(minimal({ resources, routes: [] }))).toMatch(/"approve" is not an action of this resource/);
  });

  it('accepts dotted field resources and survives non-object input', () => {
    const resources = [{ key: 'payslip.net', label: 'Net pay', actions: ['read'] }];
    const routes = [{ method: 'GET', path: '/net', access: 'private', permission: 'payslip.net.read' }];
    expect(validateManifest(minimal({ resources, routes, roles: [] })).ok).toBe(true);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('nope').ok).toBe(false);
  });
});

describe('importManifest', () => {
  useTestDatabase();

  it('adds a module, then updates it without duplicating', async () => {
    const first = await importManifest(valid(minimal()));
    expect(first).toMatchObject({ key: 'demo', created: true });

    const newer = minimal({ module: { key: 'demo', name: 'Demo', version: '1.1.0' } });
    const second = await importManifest(valid(newer));
    expect(second).toMatchObject({ version: '1.1.0', created: false });
    expect(await Module.countDocuments({ key: 'demo' })).toBe(1);
  });

  it('keeps dotted resource keys intact when stored', async () => {
    const resources = [{ key: 'payslip.net', label: 'Net pay', actions: ['read'] }];
    const roles = [{ key: 'viewer', name: 'Viewer', grants: { 'payslip.net': { actions: ['read'] } } }];
    await importManifest(valid(minimal({ resources, routes: [], roles })));
    const stored = await Module.findOne({ key: 'demo' }).lean();
    expect(stored?.roles[0]?.grants).toEqual({ 'payslip.net': { actions: ['read'] } });
  });

  it('counts people whose role disappeared in a new version', async () => {
    await importManifest(valid(minimal()));
    await User.create({ _id: 'u1', name: 'A', email: 'a@x.test', passwordHash: 'x', assignments: { demo: 'viewer' } });
    await User.create({ _id: 'u2', name: 'B', email: 'b@x.test', passwordHash: 'x', assignments: { demo: 'gone' } });
    const result = await importManifest(valid(minimal()));
    expect(result.orphanedAssignments).toBe(1);
  });

  it('refuses to create or replace a core module without allowCore', async () => {
    const core = { key: 'demo', name: 'Demo', version: '1.0.0', core: true };
    await expect(importManifest(valid(minimal({ module: core })))).rejects.toThrow(CoreModuleError);
    expect(await Module.countDocuments()).toBe(0);

    await importManifest(valid(minimal({ module: core })), { allowCore: true });
    await expect(importManifest(valid(minimal()))).rejects.toThrow(CoreModuleError);
    expect((await Module.findOne({ key: 'demo' }).lean())?.core).toBe(true);
  });
});
