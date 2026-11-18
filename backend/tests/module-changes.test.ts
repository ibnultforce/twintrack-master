import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { diffModule } from '../src/modules/master/moduleRegistry/moduleChanges.js';
import { createModuleFiles, MASTER_REPO_ROOT } from '../src/modules/master/moduleRegistry/moduleFiles.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const repoJson = (relativePath: string) => JSON.parse(readFileSync(join(MASTER_REPO_ROOT, relativePath), 'utf8'));

const noteSchema = (properties: Record<string, unknown>, required: string[]) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: { Note: { type: 'object', required, properties } },
});

describe('what a module change leaves to build', () => {
  it('lists a removed field, and a required field the schema no longer defines', () => {
    const before = { schema: noteSchema({ id: { type: 'string' }, status: { enum: ['open', 'done'] } }, ['id', 'status']) };
    const after = { schema: noteSchema({ id: { type: 'string' } }, ['id', 'status']) };

    const items = diffModule('demo', before, after);

    expect(items).toEqual([
      expect.objectContaining({ kind: 'removed', subject: 'Field Note.status', where: expect.arrayContaining(['backend/src/modules/demo/models/ (the stored record)', 'module-packs/demo/DATA_MODEL.md']) }),
      expect.objectContaining({ kind: 'changed', subject: 'Definition Note', detail: '"required" names fields it doesn\'t define: status' }),
    ]);
  });

  it('says when a new route has no backend code, and when an access rule changed', () => {
    const before = { baseUrl: '/demo', resources: [], routes: [{ method: 'GET' as const, path: '/notes', access: 'private' as const, permission: 'note.read' }] };
    const after = {
      baseUrl: '/demo',
      resources: [],
      routes: [
        { method: 'GET' as const, path: '/notes', access: 'signed' as const },
        { method: 'POST' as const, path: '/notes/:id/archive', access: 'private' as const, permission: 'note.update' },
      ],
    };

    const items = diffModule('demo', before, after);

    expect(items).toContainEqual(expect.objectContaining({ kind: 'changed', subject: 'Route GET /demo/notes', detail: 'access private, note.read → signed' }));
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'added',
      subject: 'Route POST /demo/notes/:id/archive',
      detail: 'private, note.update. No backend code serves it yet',
      where: expect.arrayContaining(['backend/src/modules/demo/ (handler, and the route in the module\'s routes list)', 'docs/api/demo.md']),
    }));
  });

  it('reports fields named like built-in object properties, and a moved base URL', () => {
    const before = { baseUrl: '/demo', resources: [], routes: [], schema: noteSchema({ id: { type: 'string' } }, ['id']) };
    const after = { baseUrl: '/notes', resources: [], routes: [], schema: noteSchema({ id: { type: 'string' }, constructor: { type: 'string' } }, ['id']) };

    const items = diffModule('demo', before, after);

    expect(items).toContainEqual(expect.objectContaining({ kind: 'added', subject: 'Field Note.constructor' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'changed', subject: 'Base URL', detail: '/demo → /notes: every route of the module moves' }));
  });

  it('finds nothing when the module is the same', () => {
    const demo = { ...repoJson('manifests/demo.manifest.json'), schema: repoJson('manifests/demo.schema.json') };
    expect(diffModule('demo', demo, demo)).toEqual([]);
  });
});

describe('module changes from imports', () => {
  useTestDatabase();

  let repoFolder: string;
  let app: Application;
  const as = async (person: string) => requestsAs(app, await signIn(app, `${person}@twintrack.test`));

  beforeEach(async () => {
    repoFolder = mkdtempSync(join(tmpdir(), 'twintrack-module-changes-'));
    app = createApp(createTestConfig(), { moduleFiles: createModuleFiles(repoFolder, 'silent') });
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { superAdmin: true });
    await addPerson('nobody');
  });

  afterEach(() => rmSync(repoFolder, { recursive: true, force: true }));

  const changeLogFile = () => join(repoFolder, 'manifests/changes/demo.md');

  it('records a schema import, lists it as pending, writes the change file and clears it once done', async () => {
    const admin = await as('farhana');
    const imported = await admin.put('/modules/demo/schema', { schema: noteSchema({ id: { type: 'string' } }, ['id']) });

    expect(imported.status).toBe(200);
    expect(imported.body.change).toEqual(expect.objectContaining({ module: 'demo', source: 'schema', status: 'pending', changedByName: 'Person farhana' }));
    expect(imported.body.changeLog).toEqual({ path: 'manifests/changes/demo.md', outcome: 'written' });
    const changeFile = readFileSync(changeLogFile(), 'utf8');
    expect(changeFile).toContain('**Removed** Field Note.title');
    expect(changeFile).toContain(`Change id: \`${imported.body.change.id}\``);

    const listed = await admin.get('/modules/demo/changes?status=pending');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(expect.objectContaining({ total: 1, pending: 1 }));
    expect(listed.body.changes[0].items).toContainEqual(expect.objectContaining({ kind: 'removed', subject: 'Definition NoteList' }));

    const done = await admin.post(`/modules/demo/changes/${imported.body.change.id}/done`);
    expect(done.status).toBe(200);
    expect(done.body.change).toEqual(expect.objectContaining({ status: 'done', doneByName: 'Person farhana' }));
    expect(done.body.changeLog).toEqual({ path: 'manifests/changes/demo.md', outcome: 'removed' });
    expect(existsSync(changeLogFile())).toBe(false);

    expect((await admin.post(`/modules/demo/changes/${imported.body.change.id}/done`)).status).toBe(409);
    expect((await admin.get('/modules/demo/changes?status=pending')).body).toEqual(expect.objectContaining({ total: 0, pending: 0 }));
  });

  it('records nothing for an import that changes nothing', async () => {
    const demo = { ...repoJson('manifests/demo.manifest.json'), schema: repoJson('manifests/demo.schema.json') };
    const imported = await (await as('farhana')).post('/modules/import', { manifest: demo, password: TEST_PASSWORD });

    expect(imported.status).toBe(200);
    expect(imported.body.change).toBeNull();
    expect(existsSync(changeLogFile())).toBe(false);
  });

  it('refuses people without module permissions, and unknown modules or changes', async () => {
    const nobody = await as('nobody');
    expect((await nobody.get('/modules/demo/changes')).status).toBe(403);
    expect((await nobody.post('/modules/demo/changes/anything/done')).status).toBe(403);

    const admin = await as('farhana');
    expect((await admin.get('/modules/nowhere/changes')).status).toBe(404);
    expect((await admin.post('/modules/demo/changes/anything/done')).body.error.code).toBe('unknown_change');
    expect((await admin.get('/modules/demo/changes?status=later')).status).toBe(422);
  });
});
