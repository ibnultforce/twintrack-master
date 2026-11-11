import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { MEHEDI: 'u_09', KARIM: 'u_08' };
const KARIMS_SALARY = 's_08';

describe('field-level security', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  /** Builds a profile with these grants, as the super admin, and gives it to the person in place of the one they had. */
  const giveProfile = async (personId: string, name: string, grants: object) => {
    const farhana = await as('farhana');
    const created = await farhana.post('/access-profiles', { name, grants });
    expect(created.status).toBe(201);
    await farhana.put(`/users/${personId}/profile`, { profileId: created.body.id });
    return created.body.id as string;
  };
  /** A profile with these HR grants. */
  const giveHrProfile = (personId: string, name: string, hrGrants: object) => giveProfile(personId, name, { hr: hrGrants });

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('hides a protected field from someone with no access to it, in lists and in history', async () => {
    await giveHrProfile(ID.MEHEDI, 'payroll-viewer', { salary: { actions: ['read'], scope: 'all' } });
    await (await as('kamrul')).patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 120000 });
    const mehedi = await as('mehedi');

    const salaries = (await mehedi.get('/hr/salaries')).body.salaries as Record<string, unknown>[];
    expect(salaries).toHaveLength(6);
    for (const salary of salaries) {
      expect(salary).not.toHaveProperty('amount');
      expect(salary).toHaveProperty('currency');
    }
    const history = (await mehedi.get(`/hr/salaries/${KARIMS_SALARY}/history`)).body.entries as { changes: { field: string }[] }[];
    expect(history.flatMap((entry) => entry.changes.map((change) => change.field))).not.toContain('amount');
    expect(JSON.stringify(history)).not.toContain('120000');
  });

  it('shows the field to someone with read access, but refuses their change to it', async () => {
    const rahim = await as('rahim');
    expect((await rahim.get('/hr/salaries')).body.salaries[0]).toHaveProperty('amount');

    await AccessProfile.updateOne({ _id: 'ap_engineering_lead' }, { $set: { 'grants.hr.salary': { actions: ['read', 'update'], scope: 'team', fieldAccess: { amount: 'read' } } } });
    const refused = await rahim.patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('field_not_editable');
    expect((await rahim.patch(`/hr/salaries/${KARIMS_SALARY}`, { currency: 'USD' })).status).toBe(200);
  });

  it('needs edit access to the field to create a salary, since it sets the amount', async () => {
    await giveHrProfile(ID.MEHEDI, 'salary-clerk', { salary: { actions: ['read', 'create'], scope: 'all', fieldAccess: { amount: 'read' } } });
    const refused = await (await as('mehedi')).post('/hr/salaries', { employeeId: ID.KARIM, amount: 1000, effectiveFrom: '2027-01-01' });
    expect(refused.body.error.code).toBe('field_not_editable');
  });

  it('lets create-only access set the field on a new salary, then refuses changing it', async () => {
    await giveHrProfile(ID.MEHEDI, 'salary-clerk', { salary: { actions: ['read', 'create', 'update'], scope: 'all', fieldAccess: { amount: 'create' } } });
    const mehedi = await as('mehedi');
    const created = await mehedi.post('/hr/salaries', { employeeId: ID.KARIM, amount: 1000, effectiveFrom: '2027-01-01' });
    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(1000);

    const refused = await mehedi.patch(`/hr/salaries/${created.body.id}`, { amount: 2000 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('field_not_editable');
    expect((await mehedi.patch(`/hr/salaries/${created.body.id}`, { currency: 'USD' })).status).toBe(200);
  });

  it('counts create-only as wider than read and narrower than edit, when building a profile', async () => {
    await giveProfile(ID.MEHEDI, 'Payroll builder', {
      master: { accessProfile: { actions: ['create'] } },
      hr: { salary: { actions: ['read', 'create'], scope: 'own', fieldAccess: { amount: 'create' } } },
    });
    const mehedi = await as('mehedi');
    expect((await mehedi.get('/me/permissions/hr')).body.fieldAccess).toMatchObject({ 'salary.amount': 'create' });

    const asking = (level: string) => ({ name: `Amount ${level}`, grants: { hr: { salary: { actions: ['read'], scope: 'own', fieldAccess: { amount: level } } } } });
    const tooMuch = await mehedi.post('/access-profiles', asking('edit'));
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.error.message).toContain('salary.amount (edit)');
    expect((await mehedi.post('/access-profiles', asking('create'))).status).toBe(201);
    expect((await mehedi.post('/access-profiles', asking('read'))).status).toBe(201);
  });

  it('refuses field access to a field the resource does not control', async () => {
    const response = await (await as('farhana')).post('/access-profiles', { name: 'Odd', grants: { hr: { salary: { actions: ['read'], fieldAccess: { employeeId: 'read' } } } } });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.fields)).toContain('is not a field of');
  });

  describe('every record field', () => {
    it('follows the actions when the grant does not name a field, leaving protected ones hidden', async () => {
      await giveHrProfile(ID.MEHEDI, 'salary-clerk', { salary: { actions: ['read', 'create'], scope: 'all' } });
      expect((await (await as('mehedi')).get('/me/permissions/hr')).body.fieldAccess).toEqual({
        'salary.currency': 'create',
        'salary.effectiveFrom': 'create',
        'salary.status': 'create',
      });
    });

    it('hides a field the grant sets to hidden, in lists and in history', async () => {
      await giveHrProfile(ID.MEHEDI, 'no-currency', { salary: { actions: ['read'], scope: 'all', fieldAccess: { currency: 'hidden' } } });
      await (await as('kamrul')).patch(`/hr/salaries/${KARIMS_SALARY}`, { currency: 'EUR' });
      const mehedi = await as('mehedi');
      const salary = ((await mehedi.get('/hr/salaries')).body.salaries as Record<string, unknown>[]).find((candidate) => candidate.id === KARIMS_SALARY);
      expect(salary).not.toHaveProperty('currency');
      expect(salary).toHaveProperty('effectiveFrom');
      const history = (await mehedi.get(`/hr/salaries/${KARIMS_SALARY}/history`)).body.entries as { changes: { field: string }[] }[];
      expect(history.flatMap((entry) => entry.changes.map((change) => change.field))).not.toContain('currency');
    });

    it('makes a field read only for someone who may otherwise update the record', async () => {
      await giveHrProfile(ID.MEHEDI, 'dates-only', { salary: { actions: ['read', 'update'], scope: 'all', fieldAccess: { currency: 'read' } } });
      const mehedi = await as('mehedi');
      const refused = await mehedi.patch(`/hr/salaries/${KARIMS_SALARY}`, { currency: 'USD' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('field_not_editable');
      expect((await mehedi.patch(`/hr/salaries/${KARIMS_SALARY}`, { effectiveFrom: '2027-02-01' })).status).toBe(200);
    });

    it('shows only the levels a profile states, not the ones that follow its actions', async () => {
      const profileId = await giveHrProfile(ID.MEHEDI, 'No currency', { salary: { actions: ['read'], scope: 'all', fieldAccess: { currency: 'hidden' } } });
      const profiles = (await (await as('farhana')).get('/access-profiles')).body.profiles as { id: string; modules: { key: string; fieldAccess: object }[] }[];
      const hr = profiles.find((profile) => profile.id === profileId)?.modules.find((module) => module.key === 'hr');
      expect(hr?.fieldAccess).toEqual({ 'salary.currency': 'hidden' });
    });
  });
});
