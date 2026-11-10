import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { RecordShare } from '../src/modules/master/models/recordShare.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { FARHANA: 'u_01', RAHIM: 'u_04', RUMANA: 'u_05', KAMRUL: 'u_06', ARIF: 'u_07', KARIM: 'u_08', MEHEDI: 'u_09', JACK: 'u_13' };
/** Karim's salary. Karim reports to Rahim, the HR Manager, so it's in Rahim's team. */
const KARIMS_SALARY = 's_08';
/** Rumana's salary, outside Rahim's team. */
const RUMANAS_SALARY = 's_05';

describe('sharing records', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const salaryIdsSeenBy = async (name: string) => ((await (await as(name)).get('/hr/salaries')).body.salaries as { id: string }[]).map((salary) => salary.id);

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    const farhana = await as('farhana');
    // Reading and editing your own salary only, so anything more has to come from a share.
    await farhana.post('/permission-sets/hr', { key: 'own-editor', name: 'Own salary editor', grants: { salary: { actions: ['read', 'update'], scope: 'own', fieldAccess: { amount: 'edit' } } } });
    for (const personId of [ID.MEHEDI, ID.KARIM, ID.ARIF]) {
      await farhana.put(`/users/${personId}/permission-sets`, { module: 'hr', permissionSets: ['own-editor'], reason: 'Testing' });
    }
  });

  describe('salaries', () => {
    it('lets a share reach a salary the scope does not, for reading only', async () => {
      expect(await salaryIdsSeenBy('mehedi')).toEqual([]);
      const shared = await (await as('rahim')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read' });
      expect(shared.status).toBe(201);
      expect(shared.body).toMatchObject({ granteeType: 'user', granteeId: ID.MEHEDI, access: 'read', sharedBy: ID.RAHIM });

      const mehedi = await as('mehedi');
      expect(await salaryIdsSeenBy('mehedi')).toEqual([KARIMS_SALARY]);
      expect((await mehedi.get(`/hr/salaries/${KARIMS_SALARY}/history`)).status).toBe(200);
      const refused = await mehedi.patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 1 });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('out_of_scope');
    });

    it('lets an edit share change the salary, and sharing again changes the access instead of adding a share', async () => {
      const rahim = await as('rahim');
      await rahim.post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read' });
      await rahim.post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'edit' });
      expect(await RecordShare.countDocuments({ recordId: KARIMS_SALARY })).toBe(1);

      const changed = await (await as('mehedi')).patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 123000 });
      expect(changed.status).toBe(200);
      expect(changed.body.updatedBy).toBe(ID.MEHEDI);
    });

    it('never adds a permission: a share does nothing for someone without salary.read', async () => {
      await (await as('kamrul')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.JACK, access: 'edit' });
      expect((await (await as('jack')).get('/hr/salaries')).status).toBe(403);
    });

    it('lets the owner share their own salary, and someone above them, but nobody else', async () => {
      const toArif = { granteeType: 'user', granteeId: ID.ARIF, access: 'read' };
      expect((await (await as('karim')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, toArif)).status).toBe(201);
      expect((await (await as('rahim')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, toArif)).status).toBe(201);

      const outsideLine = await (await as('rahim')).post(`/hr/salaries/${RUMANAS_SALARY}/shares`, toArif);
      expect(outsideLine.status).toBe(403);
      expect(outsideLine.body.error.code).toBe('may_not_share');
      const notOwner = await (await as('arif')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, { ...toArif, granteeId: ID.MEHEDI });
      expect(notOwner.body.error.code).toBe('may_not_share');
    });

    it('lets someone with salary.share share any salary their scope reaches', async () => {
      const response = await (await as('kamrul')).post(`/hr/salaries/${RUMANAS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read' });
      expect(response.status).toBe(201);
      expect(await salaryIdsSeenBy('mehedi')).toEqual([RUMANAS_SALARY]);
    });

    it('shares with everyone in an org role, or a role and everything below it', async () => {
      const kamrul = await as('kamrul');
      await kamrul.post(`/hr/salaries/${RUMANAS_SALARY}/shares`, { granteeType: 'orgRole', granteeId: 'or_engineering', access: 'read' });
      expect(await salaryIdsSeenBy('mehedi')).toContain(RUMANAS_SALARY);
      expect(await salaryIdsSeenBy('arif')).toContain(RUMANAS_SALARY);

      await kamrul.post(`/hr/salaries/s_01/shares`, { granteeType: 'orgRoleAndBelow', granteeId: 'or_engineering_lead', access: 'read' });
      expect(await salaryIdsSeenBy('mehedi')).toContain('s_01');
    });

    it('stops counting a share once it expires, and refuses one that is already past', async () => {
      await RecordShare.create({ _id: 'sh_old', module: 'hr', object: 'salary', recordId: KARIMS_SALARY, granteeType: 'user', granteeId: ID.MEHEDI, access: 'read', expiresAt: new Date(Date.now() - 1000), sharedBy: ID.KAMRUL });
      expect(await salaryIdsSeenBy('mehedi')).toEqual([]);

      const past = await (await as('kamrul')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read', expiresAt: '2020-01-01T00:00:00Z' });
      expect(past.status).toBe(422);
      expect(past.body.error.fields[0].path).toBe('expiresAt');
    });

    it('lists the shares, removes one, and records both in the activity log', async () => {
      const kamrul = await as('kamrul');
      const { body: share } = await kamrul.post(`/hr/salaries/${KARIMS_SALARY}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read' });
      expect((await kamrul.get(`/hr/salaries/${KARIMS_SALARY}/shares`)).body.shares).toEqual([expect.objectContaining({ id: share.id, granteeId: ID.MEHEDI })]);

      expect((await kamrul.delete(`/hr/salaries/${KARIMS_SALARY}/shares/${share.id}`)).status).toBe(200);
      expect(await salaryIdsSeenBy('mehedi')).toEqual([]);
      expect((await kamrul.delete(`/hr/salaries/${KARIMS_SALARY}/shares/${share.id}`)).body.error.code).toBe('unknown_share');
      expect(await AuditLog.countDocuments({ action: { $in: ['record.shared', 'record.unshared'] }, targetId: KARIMS_SALARY })).toBe(2);
    });

    it.each([
      ['a person who does not exist', { granteeType: 'user', granteeId: 'nobody', access: 'read' }],
      ['an org role that does not exist', { granteeType: 'orgRole', granteeId: 'or_nowhere', access: 'read' }],
      ['an unknown access', { granteeType: 'user', granteeId: ID.MEHEDI, access: 'own' }],
      ['an unknown grantee type', { granteeType: 'team', granteeId: ID.MEHEDI, access: 'read' }],
    ])('refuses sharing with %s', async (_label, body) => {
      expect((await (await as('kamrul')).post(`/hr/salaries/${KARIMS_SALARY}/shares`, body)).status).toBe(422);
    });

    it('opens every salary to readers when the manifest makes salaries public to read, but not to editors', async () => {
      const hr = (await Module.findOne({ key: 'hr' }).lean())!;
      await Module.updateOne({ key: 'hr' }, { $set: { resources: hr.resources.map((resource) => (resource.key === 'salary' ? { ...resource, sharingModel: 'publicRead' } : resource)) } });

      expect(await salaryIdsSeenBy('mehedi')).toHaveLength(6);
      expect((await (await as('mehedi')).patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 1 })).status).toBe(403);
    });

    it('keeps approving and deleting to the scope, whatever is shared', async () => {
      await (await as('farhana')).post('/permission-sets/hr', { key: 'own-approver', name: 'Own approver', grants: { salary: { actions: ['read', 'approve', 'delete'], scope: 'own' } } });
      await (await as('farhana')).put(`/users/${ID.MEHEDI}/permission-sets`, { module: 'hr', permissionSets: ['own-approver'], reason: 'Testing' });
      await (await as('kamrul')).post(`/hr/salaries/s_07/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'edit' });

      const mehedi = await as('mehedi');
      expect((await mehedi.patch('/hr/salaries/s_07/approve')).body.error.code).toBe('out_of_scope');
      expect((await mehedi.delete('/hr/salaries/s_07')).body.error.code).toBe('out_of_scope');
    });
  });

});
