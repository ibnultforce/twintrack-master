import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Salary } from '../src/modules/hr/models/salary.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { RecordHistory } from '../src/modules/master/models/recordHistory.js';
import { WITH_DELETED } from '../src/lib/records/recordFields.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { FARHANA: 'u_01', RAHIM: 'u_04', KAMRUL: 'u_06', ARIF: 'u_07', KARIM: 'u_08', JACK: 'u_13' };
const newSalary = { employeeId: ID.KARIM, amount: 99000, effectiveFrom: '2027-01-01' };

describe('records: history, versions and the recycle bin', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('salaries', () => {
    const createSalary = async () => (await (await as('kamrul')).post('/hr/salaries', newSalary)).body as { id: string; version: number };

    it('stamps who created and changed a salary, and moves its version on', async () => {
      const created = await createSalary();
      expect(created).toMatchObject({ version: 0, createdBy: ID.KAMRUL, updatedBy: ID.KAMRUL });

      const updated = await (await as('kamrul')).patch(`/hr/salaries/${created.id}`, { amount: 100000 });
      expect(updated.body).toMatchObject({ version: 1, updatedBy: ID.KAMRUL, amount: 100000 });
    });

    it('keeps a history of each tracked field, newest first', async () => {
      const kamrul = await as('kamrul');
      const { id } = await createSalary();
      await kamrul.patch(`/hr/salaries/${id}`, { amount: 100000 });
      await kamrul.patch(`/hr/salaries/${id}/approve`);

      const { body } = await kamrul.get(`/hr/salaries/${id}/history`);
      expect(body.total).toBe(3);
      expect(body.entries.map((entry: { action: string }) => entry.action)).toEqual(['updated', 'updated', 'created']);
      expect(body.entries[0].changes).toEqual([{ field: 'status', from: 'pending', to: 'approved' }]);
      expect(body.entries[1]).toMatchObject({ actorId: ID.KAMRUL, actorName: 'Kamrul Islam', changes: [{ field: 'amount', from: 99000, to: 100000 }] });
      expect(body.entries[2].changes).toEqual(expect.arrayContaining([
        { field: 'amount', to: 99000 },
        { field: 'effectiveFrom', to: '2027-01-01T00:00:00.000Z' },
      ]));
    });

    it('writes no history for a change that leaves every tracked field the same', async () => {
      const { id } = await createSalary();
      await (await as('kamrul')).patch(`/hr/salaries/${id}`, { amount: 99000 });
      expect(await RecordHistory.countDocuments({ recordId: id })).toBe(1);
    });

    it('takes which fields to track from the manifest, not the code', async () => {
      const { Module } = await import('../src/modules/master/models/module.js');
      const hr = (await Module.findOne({ key: 'hr' }).lean())!;
      const resources = hr.resources.map((resource) => (resource.key === 'salary' ? { ...resource, trackedFields: ['currency'] } : resource));
      await Module.updateOne({ key: 'hr' }, { $set: { resources } });

      const { id } = await createSalary();
      await (await as('kamrul')).patch(`/hr/salaries/${id}`, { amount: 123000 });
      const entries = await RecordHistory.find({ recordId: id }).lean();
      expect(entries.map((entry) => entry.action)).toEqual(['created']);
      expect(entries[0]?.changes).toEqual([{ field: 'currency', to: 'BDT' }]);
    });

    it('refuses an edit made from an old version, and saves nothing', async () => {
      const kamrul = await as('kamrul');
      const { id } = await createSalary();
      expect((await kamrul.patch(`/hr/salaries/${id}`, { amount: 100000, version: 0 })).status).toBe(200);

      const stale = await kamrul.patch(`/hr/salaries/${id}`, { amount: 1, version: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
      expect((await Salary.findById(id).lean())?.amount).toBe(100000);
      expect(await RecordHistory.countDocuments({ recordId: id })).toBe(2);
    });

    it('refuses a stale approval too', async () => {
      const kamrul = await as('kamrul');
      const { id } = await createSalary();
      await kamrul.patch(`/hr/salaries/${id}`, { amount: 100000 });
      expect((await kamrul.patch(`/hr/salaries/${id}/approve`, { version: 0 })).body.error.code).toBe('version_conflict');
      expect((await kamrul.patch(`/hr/salaries/${id}/approve`, { version: 1 })).body.status).toBe('approved');
    });

    it('moves a salary to the recycle bin, hides it everywhere else, and restores it', async () => {
      const kamrul = await as('kamrul');
      const { id } = await createSalary();
      const before = (await kamrul.get('/hr/salaries')).body.total as number;

      const deleted = await kamrul.delete(`/hr/salaries/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({ deletedBy: ID.KAMRUL, version: 1 });
      expect((await kamrul.get('/hr/salaries')).body.total).toBe(before - 1);
      expect((await kamrul.patch(`/hr/salaries/${id}`, { amount: 1 })).status).toBe(404);
      expect(await Salary.countDocuments({ _id: id })).toBe(0);
      expect(await Salary.countDocuments({ _id: id }).setOptions(WITH_DELETED)).toBe(1);

      const bin = await kamrul.get('/hr/salaries?deleted=true');
      expect(bin.body.salaries.map((salary: { id: string }) => salary.id)).toEqual([id]);

      const restored = await kamrul.post(`/hr/salaries/${id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body.deletedAt).toBeUndefined();
      expect((await kamrul.get('/hr/salaries')).body.total).toBe(before);
      expect((await kamrul.get(`/hr/salaries/${id}/history`)).body.entries.map((entry: { action: string }) => entry.action)).toEqual(['restored', 'deleted', 'created']);
      expect(await AuditLog.countDocuments({ action: { $in: ['salary.deleted', 'salary.restored'] }, targetId: id })).toBe(2);
    });

    it('answers 404 for deleting twice, or restoring one that is not deleted', async () => {
      const kamrul = await as('kamrul');
      const { id } = await createSalary();
      expect((await kamrul.post(`/hr/salaries/${id}/restore`)).status).toBe(404);
      await kamrul.delete(`/hr/salaries/${id}`);
      expect((await kamrul.delete(`/hr/salaries/${id}`)).status).toBe(404);
    });

    it('keeps the recycle bin and deleting to people who hold salary.delete', async () => {
      const { id } = await createSalary();
      const rahim = await as('rahim');
      expect((await rahim.get('/hr/salaries?deleted=true')).status).toBe(403);
      expect((await rahim.delete(`/hr/salaries/${id}`)).status).toBe(403);
    });

    it('shows the history only within the reader\'s reach', async () => {
      const { id } = await createSalary();
      expect((await (await as('rahim')).get(`/hr/salaries/${id}/history`)).status).toBe(200);
      const farhana = await as('farhana');
      const outside = (await farhana.post('/hr/salaries', { ...newSalary, employeeId: ID.JACK })).body.id as string;
      const refused = await (await as('rahim')).get(`/hr/salaries/${outside}/history`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('out_of_scope');
    });

    it('keeps amounts out of the activity log, though the history holds them', async () => {
      const { id } = await createSalary();
      await (await as('kamrul')).patch(`/hr/salaries/${id}`, { amount: 100000 });
      expect(JSON.stringify(await AuditLog.find({ targetId: id }).lean())).not.toContain('100000');
    });
  });
});
