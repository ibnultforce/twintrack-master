import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { peopleInScope } from '../src/modules/master/access/scope.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { OrgRole } from '../src/modules/master/models/orgRole.js';
import { validateOrgRolesFile } from '../src/modules/master/orgRoles/orgRolesFile.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

describe('org roles', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const ancestorsOf = async (id: string) => (await OrgRole.findById(id).lean())?.ancestorIds;

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  // root
  // ├── sales
  // │   └── sales_east
  // │       └── sales_east_team
  // └── hr
  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('root');
    await addOrgRole('sales', 'root');
    await addOrgRole('sales_east', 'sales');
    await addOrgRole('sales_east_team', 'sales_east');
    await addOrgRole('hr', 'root');
    await addPerson('farhana', { superAdmin: true, orgRoleId: 'root' });
    await addPerson('alia', { name: 'Alia Access', profileId: 'ap_access_admin', orgRoleId: 'hr' });
    await addPerson('rumana', { profileId: 'ap_auditor', orgRoleId: 'hr' });
    await addPerson('karim', { orgRoleId: 'sales_east_team' });
  });

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch' | 'delete', string, object?][] = [
      ['list', 'get', '/org-roles'],
      ['create', 'post', '/org-roles', { name: 'New', parentId: 'root' }],
      ['update', 'patch', '/org-roles/hr', { name: 'People' }],
      ['delete', 'delete', '/org-roles/hr'],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused for someone with no Master role', async (_label, method, path, body) => {
      const karim = await as('karim');
      const response = await (method === 'get' || method === 'delete' ? karim[method](path) : karim[method](path, body));
      expect(response.status).toBe(403);
    });

    it('lets an auditor read the tree but change nothing', async () => {
      const auditor = await as('rumana');
      expect((await auditor.get('/org-roles')).status).toBe(200);
      expect((await auditor.post('/org-roles', { name: 'New', parentId: 'root' })).status).toBe(403);
    });
  });

  describe('GET /org-roles', () => {
    it('lists parents before children, with depth and how many people hold each role', async () => {
      const { body } = await (await as('alia')).get('/org-roles');
      expect(body.orgRoles[0]).toMatchObject({ id: 'root', parentId: null, depth: 0, peopleCount: 1 });
      expect(body.orgRoles.find((role: { id: string }) => role.id === 'sales_east_team')).toMatchObject({ parentId: 'sales_east', depth: 3, peopleCount: 1 });
      expect(body.orgRoles.find((role: { id: string }) => role.id === 'hr')).toMatchObject({ peopleCount: 2 });
    });
  });

  describe('POST /org-roles', () => {
    it('adds a role below a parent and records it', async () => {
      const response = await (await as('alia')).post('/org-roles', { name: 'Sales West', parentId: 'sales' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ name: 'Sales West', parentId: 'sales', depth: 2, peopleCount: 0, createdAt: expect.any(String), updatedAt: expect.any(String) });
      expect(await ancestorsOf(response.body.id)).toEqual(['root', 'sales']);
      expect(await AuditLog.countDocuments({ action: 'org_role.created', actorId: 'alia' })).toBe(1);
    });

    it('refuses a second root', async () => {
      const response = await (await as('alia')).post('/org-roles', { name: 'Another top' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('parentId');
    });

    it('creates the root when the tree is empty', async () => {
      await OrgRole.deleteMany({});
      const response = await (await as('farhana')).post('/org-roles', { name: 'Company' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ parentId: null, depth: 0 });
    });

    it.each([
      ['a parent that does not exist', { name: 'X', parentId: 'nowhere' }],
      ['a blank name', { name: ' ', parentId: 'root' }],
      ['other fields', { name: 'X', parentId: 'root', ancestorIds: [] }],
    ])('refuses %s', async (_label, body) => {
      expect((await (await as('alia')).post('/org-roles', body)).status).toBe(422);
    });
  });

  describe('PATCH /org-roles/:id', () => {
    it('renames a role and clears its description', async () => {
      const admin = await as('alia');
      await admin.patch('/org-roles/hr', { description: 'People team' });
      const response = await admin.patch('/org-roles/hr', { name: 'People', description: null });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'People' });
      expect(response.body.description).toBeUndefined();
    });

    it('moves a role and everything below it', async () => {
      const response = await (await as('alia')).patch('/org-roles/sales_east', { parentId: 'hr' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ parentId: 'hr', depth: 2 });
      expect(await ancestorsOf('sales_east')).toEqual(['root', 'hr']);
      expect(await ancestorsOf('sales_east_team')).toEqual(['root', 'hr', 'sales_east']);
      expect(await AuditLog.countDocuments({ action: 'org_role.moved' })).toBe(1);
    });

    it.each([
      ['below itself', 'sales', 'sales'],
      ['below its own descendant', 'sales', 'sales_east_team'],
      ['the root anywhere', 'root', 'hr'],
      ['below a role that does not exist', 'sales', 'nowhere'],
    ])('refuses to move %s', async (_label, id, parentId) => {
      const response = await (await as('alia')).patch(`/org-roles/${id}`, { parentId });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('parentId');
      expect(await ancestorsOf('sales_east_team')).toEqual(['root', 'sales', 'sales_east']);
    });

    it('lets nobody move the role they hold, except a super admin', async () => {
      const response = await (await as('alia')).patch('/org-roles/hr', { parentId: 'sales' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_org_role');
      expect((await (await as('alia')).patch('/org-roles/hr', { name: 'People' })).status).toBe(200);
    });

    it('answers 404 for a role that does not exist, and 422 for an empty change', async () => {
      const admin = await as('alia');
      expect((await admin.patch('/org-roles/nowhere', { name: 'X' })).status).toBe(404);
      expect((await admin.patch('/org-roles/hr', {})).status).toBe(422);
    });
  });

  describe('DELETE /org-roles/:id', () => {
    it('removes an empty leaf', async () => {
      await addOrgRole('empty', 'root');
      expect((await (await as('alia')).delete('/org-roles/empty')).status).toBe(204);
      expect(await OrgRole.countDocuments({ _id: 'empty' })).toBe(0);
      expect(await AuditLog.countDocuments({ action: 'org_role.deleted' })).toBe(1);
    });

    it.each([
      ['has roles below it', 'sales_east', 'org_role_has_children'],
      ['people hold it', 'sales_east_team', 'org_role_in_use'],
    ])('refuses a role that %s', async (_label, id, code) => {
      const response = await (await as('alia')).delete(`/org-roles/${id}`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(code);
    });

    it('answers 404 for a role that does not exist', async () => {
      expect((await (await as('alia')).delete('/org-roles/nowhere')).status).toBe(404);
    });
  });

  describe('team scope', () => {
    beforeEach(async () => {
      await addPerson('jasmin', { orgRoleId: 'sales' });
      await addPerson('jack', { orgRoleId: 'sales_east' });
      await addPerson('nadia', { orgRoleId: 'sales' });
      await addPerson('rahim', { orgRoleId: 'hr', managerId: 'jasmin' });
    });

    it('reaches everyone in the roles below, at any depth, plus direct reports', async () => {
      expect((await peopleInScope('jasmin', 'team'))?.sort()).toEqual(['jack', 'jasmin', 'karim', 'rahim']);
    });

    it('leaves out peers who share the role', async () => {
      expect(await peopleInScope('jasmin', 'team')).not.toContain('nadia');
    });

    it('reaches only the person when nobody is below them', async () => {
      expect(await peopleInScope('karim', 'team')).toEqual(['karim']);
    });

    it('follows a move in the tree on the next call', async () => {
      await (await as('farhana')).patch('/org-roles/sales_east', { parentId: 'hr' });
      expect((await peopleInScope('jasmin', 'team'))?.sort()).toEqual(['jasmin', 'rahim']);
    });
  });
});

describe('org roles file', () => {
  const errorsFor = (orgRoles: unknown[]) => {
    const result = validateOrgRolesFile({ type: 'orgRoles', orgRoles });
    return result.ok ? '' : JSON.stringify(result.errors);
  };

  it('works out each role ancestors', () => {
    const result = validateOrgRolesFile({ type: 'orgRoles', orgRoles: [{ id: 'b', name: 'B', parentId: 'a' }, { id: 'a', name: 'A' }] });
    expect(result.ok && result.value).toEqual([
      expect.objectContaining({ _id: 'b', ancestorIds: ['a'] }),
      expect.objectContaining({ _id: 'a', ancestorIds: [], isRoot: true }),
    ]);
  });

  it.each([
    ['two roots', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], 'exactly one role'],
    ['a missing parent', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'x' }], 'not in this file'],
    ['a circle', [{ id: 'r', name: 'R' }, { id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }], 'circle'],
    ['a repeated id', [{ id: 'a', name: 'A' }, { id: 'a', name: 'Again', parentId: 'a' }], 'used twice'],
  ])('refuses %s', (_label, orgRoles, message) => {
    expect(errorsFor(orgRoles)).toContain(message);
  });
});
