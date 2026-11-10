import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { User } from '../src/modules/master/models/user.js';
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
  const giveSet = async (personId: string, key: string, grants: object) => {
    const farhana = await as('farhana');
    await farhana.post('/permission-sets/hr', { key, name: key, grants });
    await farhana.put(`/users/${personId}/permission-sets`, { module: 'hr', permissionSets: [key], reason: 'Testing' });
  };

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('hides a protected field from someone with no access to it, in lists and in history', async () => {
    await giveSet(ID.MEHEDI, 'payroll-viewer', { salary: { actions: ['read'], scope: 'all' } });
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

    await (await as('farhana')).patch('/permission-sets/hr/manager', { grants: { salary: { actions: ['read', 'update'], scope: 'team', fieldAccess: { amount: 'read' } } } });
    const refused = await rahim.patch(`/hr/salaries/${KARIMS_SALARY}`, { amount: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('field_not_editable');
    expect((await rahim.patch(`/hr/salaries/${KARIMS_SALARY}`, { currency: 'USD' })).status).toBe(200);
  });

  it('needs edit access to the field to create a salary, since it sets the amount', async () => {
    await giveSet(ID.MEHEDI, 'salary-clerk', { salary: { actions: ['read', 'create'], scope: 'all', fieldAccess: { amount: 'read' } } });
    const refused = await (await as('mehedi')).post('/hr/salaries', { employeeId: ID.KARIM, amount: 1000, effectiveFrom: '2027-01-01' });
    expect(refused.body.error.code).toBe('field_not_editable');
  });

  it('takes the widest field access from the profile and permission sets together', async () => {
    await giveSet(ID.MEHEDI, 'payroll-viewer', { salary: { actions: ['read'], scope: 'all' } });
    await AccessProfile.create({ _id: 'ap_payroll', name: 'Payroll', grants: { hr: { salary: { actions: ['read'], scope: 'own', fieldAccess: { amount: 'read' } } } } });
    await User.updateOne({ _id: ID.MEHEDI }, { $set: { profileId: 'ap_payroll' } });
    expect((await (await as('mehedi')).get('/hr/salaries')).body.salaries[0]).toHaveProperty('amount');
    expect((await (await as('mehedi')).get('/me/permissions/hr')).body.fieldAccess).toEqual({ 'salary.amount': 'read' });
  });

  it('stops anyone giving field access beyond their own', async () => {
    const farhana = await as('farhana');
    await farhana.post('/access-profiles', { name: 'Builder', grants: { hr: { permissionSet: { actions: ['create'] }, salary: { actions: ['read'], scope: 'team', fieldAccess: { amount: 'read' } } } } })
      .then(async ({ body }) => User.updateOne({ _id: ID.MEHEDI }, { $set: { profileId: body.id } }));
    const mehedi = await as('mehedi');
    const tooMuch = await mehedi.post('/permission-sets/hr', { key: 'amount-editor', name: 'Amount editor', grants: { salary: { actions: ['read'], scope: 'team', fieldAccess: { amount: 'edit' } } } });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.error.message).toContain('salary.amount (edit)');
    expect((await mehedi.post('/permission-sets/hr', { key: 'amount-reader', name: 'Amount reader', grants: { salary: { actions: ['read'], scope: 'team', fieldAccess: { amount: 'read' } } } })).status).toBe(201);
  });

  it('refuses field access to a field the resource does not protect', async () => {
    const response = await (await as('farhana')).post('/permission-sets/hr', { key: 'odd', name: 'Odd', grants: { salary: { actions: ['read'], fieldAccess: { currency: 'read' } } } });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.fields)).toContain('not a protected field');
  });
});
