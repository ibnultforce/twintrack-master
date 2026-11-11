import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

describe('clients', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const acme = { name: 'Acme Ltd', initials: 'acme', contactEmail: 'Billing@Acme.test', contactPhone: '+880 1700 000000', notes: 'Pays in USD.' };

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await AccessProfile.create({ _id: 'ap_clients', name: 'Client manager', grants: { master: { client: { actions: ['read', 'create', 'update'] } } } });
    await AccessProfile.create({
      _id: 'ap_client_reader',
      name: 'Client reader',
      grants: { master: { client: { actions: ['read'], fieldAccess: { notes: 'hidden' } } } },
    });
    await addPerson('sales', { name: 'Sara Sales', profileId: 'ap_clients', orgRoleId: 'or_root' });
    await addPerson('viewer', { name: 'Vik Viewer', profileId: 'ap_client_reader', orgRoleId: 'or_root' });
    await addPerson('karim', { orgRoleId: 'or_root' });
  });

  const addAcme = async () => (await (await as('sales')).post('/clients', acme)).body as { id: string; version: number };

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch', string, object?][] = [
      ['list', 'get', '/clients'],
      ['add', 'post', '/clients', { name: 'X' }],
      ['read', 'get', '/clients/cl_1'],
      ['edit', 'patch', '/clients/cl_1', { name: 'Y' }],
      ['set status', 'patch', '/clients/cl_1/status', { status: 'inactive' }],
      ['history', 'get', '/clients/cl_1/history'],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused without a client permission', async (_label, method, path, body) => {
      const karim = await as('karim');
      expect((await (method === 'get' ? karim.get(path) : karim[method](path, body))).status).toBe(403);
    });

    it('lets a reader see clients but change nothing', async () => {
      const { id } = await addAcme();
      const viewer = await as('viewer');
      expect((await viewer.get(`/clients/${id}`)).status).toBe(200);
      expect((await viewer.post('/clients', { name: 'New' })).status).toBe(403);
      expect((await viewer.patch(`/clients/${id}`, { name: 'Changed' })).status).toBe(403);
    });
  });

  describe('adding and listing', () => {
    it('adds a client, with initials in capitals and the email in lower case', async () => {
      const response = await (await as('sales')).post('/clients', acme);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        id: expect.stringMatching(/^cl_/),
        name: 'Acme Ltd',
        initials: 'ACME',
        contactEmail: 'billing@acme.test',
        status: 'active',
        version: 0,
        createdBy: 'sales',
      });
      expect(await AuditLog.exists({ action: 'client.created', targetId: response.body.id })).toBeTruthy();
    });

    it('refuses initials another client uses, whatever their case', async () => {
      await addAcme();
      const response = await (await as('sales')).post('/clients', { name: 'Acme Two', initials: 'Acme' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('initials_taken');
    });

    it.each([{}, { name: '' }, { name: 'X', initials: 'TOO-LONG-CODE' }, { name: 'X', contactEmail: 'nope' }, { name: 'X', status: 'inactive' }])(
      'refuses the body %j',
      async (body) => {
        expect((await (await as('sales')).post('/clients', body)).status).toBe(422);
      },
    );

    it('lists clients by name, filters by status and searches', async () => {
      const admin = await as('sales');
      await admin.post('/clients', { name: 'Zeta Corp' });
      const { id } = await addAcme();
      await admin.patch(`/clients/${id}/status`, { status: 'inactive' });

      expect((await admin.get('/clients')).body.clients.map((client: { name: string }) => client.name)).toEqual(['Acme Ltd', 'Zeta Corp']);
      expect((await admin.get('/clients?status=active')).body).toMatchObject({ total: 1, clients: [{ name: 'Zeta Corp' }] });
      expect((await admin.get('/clients?search=acme')).body.total).toBe(1);
    });

    it('hides fields the profile marks hidden', async () => {
      const { id } = await addAcme();
      const seen = (await (await as('viewer')).get(`/clients/${id}`)).body;
      expect(seen).not.toHaveProperty('notes');
      expect(seen.name).toBe('Acme Ltd');
    });

    it('answers 404 for a client that does not exist', async () => {
      const response = await (await as('sales')).get('/clients/cl_nobody');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_client');
    });
  });

  describe('changing a client', () => {
    it('saves changes, clears a detail with null and moves the version on', async () => {
      const { id } = await addAcme();
      const response = await (await as('sales')).patch(`/clients/${id}`, { name: 'Acme Limited', contactPhone: null, version: 0 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Acme Limited', version: 1, updatedBy: 'sales' });
      expect(response.body).not.toHaveProperty('contactPhone');
    });

    it('refuses an edit made from an old copy', async () => {
      const { id } = await addAcme();
      const admin = await as('sales');
      await admin.patch(`/clients/${id}`, { name: 'First', version: 0 });
      const stale = await admin.patch(`/clients/${id}`, { name: 'Second', version: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
    });

    it('deactivates and reactivates, logging each', async () => {
      const { id } = await addAcme();
      const admin = await as('sales');
      expect((await admin.patch(`/clients/${id}/status`, { status: 'inactive' })).body.status).toBe('inactive');
      expect((await admin.patch(`/clients/${id}/status`, { status: 'active' })).body.status).toBe('active');
      expect(await AuditLog.find({ targetId: id }).distinct('action')).toEqual(
        expect.arrayContaining(['client.created', 'client.deactivated', 'client.reactivated']),
      );
    });

    it('does not let the edit route change the status', async () => {
      const { id } = await addAcme();
      expect((await (await as('sales')).patch(`/clients/${id}`, { status: 'inactive' })).status).toBe(422);
    });

    it('refuses initials another client uses', async () => {
      await addAcme();
      const admin = await as('sales');
      const other = (await admin.post('/clients', { name: 'Other', initials: 'OTH' })).body;
      expect((await admin.patch(`/clients/${other.id}`, { initials: 'ACME' })).body.error.code).toBe('initials_taken');
    });
  });

  describe('GET /clients/:id/history', () => {
    it('lists changes to tracked fields, newest first', async () => {
      const { id } = await addAcme();
      await (await as('sales')).patch(`/clients/${id}`, { name: 'Acme Limited' });
      const { body } = await (await as('viewer')).get(`/clients/${id}/history`);
      expect(body.entries[0]).toMatchObject({ action: 'updated', changes: [{ field: 'name', from: 'Acme Ltd', to: 'Acme Limited' }] });
      expect(body.entries[1]).toMatchObject({ action: 'created' });
    });
  });
});
