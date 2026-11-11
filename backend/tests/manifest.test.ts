import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Module } from '../src/modules/master/models/module.js';
import { checkGrants, validateManifest, type Manifest } from '../src/modules/master/moduleRegistry/manifest.js';
import { CoreModuleError, importManifest } from '../src/modules/master/moduleRegistry/moduleRegistry.service.js';
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
  resources: [{ key: 'thing', label: 'Things', actions: ['read', 'approve'], scoped: true }],
  routes: [{ method: 'GET', path: '/things', access: 'private', permission: 'thing.read' }],
  ...overrides,
});

const valid = (raw: unknown): Manifest => {
  const result = validateManifest(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};

describe('validateManifest', () => {
  const manifestFiles = readdirSync(new URL('../../manifests/', import.meta.url));

  it('finds one manifest for each module', () => {
    expect(manifestFiles.sort()).toEqual([
      'hr.manifest.json',
      'master.manifest.json',
      'tasks.manifest.json',
    ]);
  });

  it.each(manifestFiles)('accepts %s, whose module key matches its file name', (fileName) => {
    const manifest = valid(readJson(`../../manifests/${fileName}`));
    expect(`${manifest.module.key}.manifest.json`).toBe(fileName);
  });

  it('reports every problem in the invalid sample at once', () => {
    const text = messages(readJson('./fixtures/manifest-invalid.json'));
    expect(text).toMatch(/module\.key/);
    expect(text).toMatch(/module\.version/);
    expect(text).toMatch(/resources\.0\.actions\.2/);
    expect(text).toMatch(/routes\.0: a private route needs a permission/);
    expect(text).toMatch(/"run\.create" is not an action/);
    expect(text).toMatch(/routes\.2\.method/);
    expect(text).toMatch(/permissionSets: permission sets were removed/);
  });

  it('rejects a module key that would find a JavaScript built-in', () => {
    expect(messages(minimal({ module: { key: 'constructor', name: 'Demo', version: '1.0.0' } }))).toMatch(/module\.key/);
    expect(validateManifest(minimal({ module: { key: 'constructors', name: 'Demo', version: '1.0.0' } })).ok).toBe(true);
  });

  it.each(['public', 'signed'])('rejects a permission on a %s route, which would never be checked', (access) => {
    const routes = [{ method: 'GET', path: '/things', access, permission: 'thing.read' }];
    expect(messages(minimal({ routes }))).toMatch(new RegExp(`routes\\.0: a ${access} route can't require a permission`));
  });

  it('rejects the old roles, grantable, managesAccessOf and permission set fields, which profiles replaced', () => {
    const resources = [{ key: 'thing', label: 'Things', actions: ['read'], grantable: ['read'], managesAccessOf: 'hr' }];
    const text = messages(minimal({ resources, routes: [], roles: [], permissionSets: [] }));
    expect(text).toMatch(/resources\.0\.grantable: grantable was removed/);
    expect(text).toMatch(/resources\.0\.managesAccessOf: managesAccessOf was removed/);
    expect(text).toMatch(/roles: roles were removed/);
    expect(text).toMatch(/permissionSets: permission sets were removed/);
  });

  it('accepts dotted field resources and survives non-object input', () => {
    const resources = [{ key: 'payslip.net', label: 'Net pay', actions: ['read'] }];
    const routes = [{ method: 'GET', path: '/net', access: 'private', permission: 'payslip.net.read' }];
    expect(validateManifest(minimal({ resources, routes })).ok).toBe(true);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('nope').ok).toBe(false);
  });
});

describe('checkGrants, which profiles use', () => {
  const resources = [
    { key: 'thing', label: 'Things', actions: ['read', 'approve'], scoped: true },
    { key: 'plain', label: 'Plain', actions: ['read'] },
  ];
  const problems = (grants: unknown) => checkGrants(grants, resources, 'grants').map((error) => `${error.path}: ${error.message}`).join('\n');

  it('rejects an action the resource does not have, and an unknown resource', () => {
    expect(problems({ thing: { actions: ['delete'] } })).toMatch(/"delete" is not an action of "thing"/);
    expect(problems({ ghost: { actions: ['read'] } })).toMatch(/"ghost" is not a resource/);
  });

  it('rejects a narrow scope on a resource that is not scoped, but accepts "all"', () => {
    expect(problems({ plain: { actions: ['read'], scope: 'team' } })).toMatch(/"plain" isn't scoped/);
    expect(problems({ plain: { actions: ['read'], scope: 'all' } })).toBe('');
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
    await importManifest(valid(minimal({ resources, routes: [] })));
    const stored = await Module.findOne({ key: 'demo' }).lean();
    expect(stored?.resources[0]?.key).toBe('payslip.net');
  });

  it('drops permission sets a module saved before they were removed', async () => {
    await Module.collection.insertOne({ key: 'demo', name: 'Demo', version: '0.9.0', core: false, resources: [], routes: [], permissionSets: [{ key: 'old' }] });
    await importManifest(valid(minimal()));
    expect(await Module.collection.findOne({ key: 'demo' })).not.toHaveProperty('permissionSets');
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
