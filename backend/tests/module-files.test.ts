import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createModuleFiles, MASTER_REPO_ROOT } from '../src/modules/master/moduleRegistry/moduleFiles.js';
import { validateManifest } from '../src/modules/master/moduleRegistry/manifest.js';
import { readManifestFiles } from '../src/seed/seedFiles.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig, TEST_ENV } from './helpers/testConfig.js';

const repoText = (relativePath: string) => readFileSync(join(MASTER_REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
const readJson = (folder: string, relativePath: string) => JSON.parse(readFileSync(join(folder, relativePath), 'utf8'));

const inventoryManifest = (routes: unknown[] = []) => ({
  manifestVersion: 1,
  module: { key: 'inventory', name: 'Inventory', version: '1.0.0', baseUrl: '/inventory' },
  resources: [{ key: 'item', label: 'Items', actions: ['read'] }],
  routes,
});
const itemSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'TwinTrack Inventory API', $defs: { Item: { type: 'object' } } };

describe('keeping the repo files in step with module imports', () => {
  useTestDatabase();

  let repoFolder: string;
  let app: Application;
  const asAdmin = async () => requestsAs(app, await signIn(app, 'farhana@twintrack.test'));

  beforeEach(async () => {
    repoFolder = mkdtempSync(join(tmpdir(), 'twintrack-module-files-'));
    app = createApp(createTestConfig(), { moduleFiles: createModuleFiles(repoFolder, 'silent') });
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { superAdmin: true });
  });

  afterEach(() => rmSync(repoFolder, { recursive: true, force: true }));

  it('writes an imported manifest and its schema exactly as the repo keeps them', async () => {
    const demo = JSON.parse(repoText('manifests/demo.manifest.json'));
    const schema = JSON.parse(repoText('manifests/demo.schema.json'));
    const response = await (await asAdmin()).post('/modules/import', { manifest: { ...demo, schema }, password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual(expect.objectContaining({
      synced: true,
      written: ['manifests/demo.manifest.json', 'manifests/demo.schema.json'],
      unchanged: [],
      routesWithoutCode: [],
    }));
    // Byte for byte, so importing a file back unchanged never shows up as a change in git.
    expect(readFileSync(join(repoFolder, 'manifests/demo.manifest.json'), 'utf8')).toBe(repoText('manifests/demo.manifest.json'));
    expect(readFileSync(join(repoFolder, 'manifests/demo.schema.json'), 'utf8')).toBe(repoText('manifests/demo.schema.json'));
  });

  it('writes a file the seed accepts, and keeps the schema file when the manifest carries none', async () => {
    const admin = await asAdmin();
    await admin.put('/modules/inventory/schema', { schema: itemSchema }).expect(404);
    await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD }).expect(201);
    const schemaResponse = await admin.put('/modules/inventory/schema', { schema: { ...itemSchema, 'x-instructions': ['dropped'] } });
    expect(schemaResponse.body.files).toEqual(expect.objectContaining({ synced: true, written: ['manifests/inventory.schema.json'] }));
    expect(readJson(repoFolder, 'manifests/inventory.schema.json')).toEqual(itemSchema);

    const again = await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
    expect(again.body.files).toEqual(expect.objectContaining({ written: [], unchanged: ['manifests/inventory.manifest.json'] }));
    expect(readJson(repoFolder, 'manifests/inventory.schema.json')).toEqual(itemSchema);
    expect(validateManifest({ ...readJson(repoFolder, 'manifests/inventory.manifest.json'), schema: itemSchema }).ok).toBe(true);
  });

  it('leaves a hand-formatted file alone when an import brings the same content', async () => {
    // projects.schema.json is formatted by hand, with short definitions on one line each.
    mkdirSync(join(repoFolder, 'manifests'));
    for (const name of ['projects.manifest.json', 'projects.schema.json']) copyFileSync(join(MASTER_REPO_ROOT, 'manifests', name), join(repoFolder, 'manifests', name));
    const before = ['projects.manifest.json', 'projects.schema.json'].map((name) => readFileSync(join(repoFolder, 'manifests', name)));

    const files = createModuleFiles(repoFolder, 'silent');
    const validated = validateManifest({ ...readJson(repoFolder, 'manifests/projects.manifest.json'), schema: readJson(repoFolder, 'manifests/projects.schema.json') });
    if (!validated.ok) throw new Error('the repo manifest is invalid');
    const report = await files.saveManifest(validated.value);

    expect(report).toEqual(expect.objectContaining({ written: [], unchanged: ['manifests/projects.manifest.json', 'manifests/projects.schema.json'] }));
    const after = ['projects.manifest.json', 'projects.schema.json'].map((name) => readFileSync(join(repoFolder, 'manifests', name)));
    expect(after).toEqual(before);
  });

  it('changes only what changed, keeping the key order and line endings of the file', async () => {
    mkdirSync(join(repoFolder, 'manifests'));
    const original = { manifestVersion: 1, module: { name: 'Inventory', key: 'inventory', version: '1.0.0', baseUrl: '/inventory' }, routes: [], resources: [{ label: 'Items', key: 'item', actions: ['read'] }] };
    writeFileSync(join(repoFolder, 'manifests/inventory.manifest.json'), `${JSON.stringify(original, null, 2)}\n`.replaceAll('\n', '\r\n'));

    const files = createModuleFiles(repoFolder, 'silent');
    const validated = validateManifest({ ...original, module: { ...original.module, version: '1.1.0' } });
    if (!validated.ok) throw new Error('fixture manifest is invalid');
    expect((await files.saveManifest(validated.value)).written).toEqual(['manifests/inventory.manifest.json']);

    const expected = `${JSON.stringify({ ...original, module: { ...original.module, version: '1.1.0' } }, null, 2)}\n`.replaceAll('\n', '\r\n');
    expect(readFileSync(join(repoFolder, 'manifests/inventory.manifest.json'), 'utf8')).toBe(expected);
  });

  it('names the routes a manifest lists that have no backend code yet', async () => {
    const manifest = inventoryManifest([
      { method: 'GET', path: '/items', access: 'private', permission: 'item.read' },
      { method: 'GET', path: '/items/:id', access: 'private', permission: 'item.read', planned: true },
    ]);
    const response = await (await asAdmin()).post('/modules/import', { manifest, password: TEST_PASSWORD });
    expect(response.body.files.routesWithoutCode).toEqual(['GET /inventory/items']);
  });

  it('writes nothing when an import is refused', async () => {
    const admin = await asAdmin();
    expect((await admin.post('/modules/import', { manifest: { manifestVersion: 1 }, password: TEST_PASSWORD })).status).toBe(422);
    expect((await admin.put('/modules/demo/schema', { schema: { title: 'no defs' } })).status).toBe(422);
    expect((await admin.post('/modules/import', { manifest: inventoryManifest(), password: 'wrong-password' })).status).toBe(403);
    expect(existsSync(join(repoFolder, 'manifests'))).toBe(false);
  });

  it('deletes the files of a removed module and keeps its pack folder', async () => {
    const admin = await asAdmin();
    await admin.post('/modules/import', { manifest: { ...inventoryManifest(), schema: itemSchema }, password: TEST_PASSWORD }).expect(201);
    const response = await admin.delete('/modules/inventory');
    expect(response.body.files).toEqual(expect.objectContaining({
      synced: true,
      removed: ['manifests/inventory.manifest.json', 'manifests/inventory.schema.json', 'manifests/changes/inventory.md'],
    }));
    expect(readdirSync(join(repoFolder, 'manifests'), { recursive: true }).filter((name) => String(name).includes('.'))).toEqual([]);
  });

  it('reports why the pack was not rebuilt', async () => {
    const response = await (await asAdmin()).post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
    expect(response.body.files.pack).toEqual({ rebuilt: false, message: 'scripts/exportModulePack.mjs is not in this repo.' });
  });

  it('still saves the import when the files cannot be written, and says so', async () => {
    // A file where the manifests folder should be makes every write fail.
    writeFileSync(join(repoFolder, 'manifests'), '');
    const response = await (await asAdmin()).post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
    expect(response.status).toBe(201);
    expect(response.body.files).toEqual(expect.objectContaining({ synced: false, written: [] }));
    expect(response.body.files.warning).toMatch(/saved in the database, but the repo files could not be written/);
    expect((await (await asAdmin()).get('/modules/inventory/export')).status).toBe(200);
  });

  it('leaves out custom objects, which live only in the database', async () => {
    const files = createModuleFiles(repoFolder, 'silent');
    const validated = validateManifest(inventoryManifest());
    if (!validated.ok) throw new Error('fixture manifest is invalid');
    const manifest = validated.value;
    await files.saveManifest({ ...manifest, resources: [...manifest.resources, { key: 'asset', label: 'Assets', actions: ['read'], custom: true }] });
    expect(readJson(repoFolder, 'manifests/inventory.manifest.json').resources.map((resource: { key: string }) => resource.key)).toEqual(['item']);
  });
});

describe('the module file sync setting', () => {
  it('is on in development, off in tests and production, and refused in production', () => {
    const environment: Record<string, string> = { ...TEST_ENV };
    delete environment.MODULE_FILE_SYNC_ENABLED;
    expect(loadConfig({ ...environment, NODE_ENV: 'development' }).isModuleFileSyncEnabled).toBe(true);
    expect(loadConfig({ ...environment, NODE_ENV: 'test' }).isModuleFileSyncEnabled).toBe(false);
    expect(createTestConfig().isModuleFileSyncEnabled).toBe(false);
    expect(() => loadConfig({ ...environment, NODE_ENV: 'production', MODULE_FILE_SYNC_ENABLED: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...environment, NODE_ENV: 'production', MODULE_FILE_SYNC_ENABLED: 'true' })).toThrow(/MODULE_FILE_SYNC_ENABLED: must not be true in production/);
  });
});

describe('the seed', () => {
  it('loads every manifest file in manifests/, Master first', () => {
    const keys = readManifestFiles().map((manifest) => (manifest as { module: { key: string } }).module.key);
    const files = readdirSync(join(MASTER_REPO_ROOT, 'manifests')).filter((name) => name.endsWith('.manifest.json'));
    expect(keys[0]).toBe('master');
    expect([...keys].sort()).toEqual(files.map((name) => name.replace('.manifest.json', '')).sort());
  });
});
