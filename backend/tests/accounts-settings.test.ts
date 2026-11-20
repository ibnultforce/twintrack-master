import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { isStandInActive } from '../src/modules/accounts/settings/settings.service.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const BASE = '/accounts/settings';

describe('Accounts settings', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await AccessProfile.create([
      { _id: 'ap_settings_reader', name: 'Settings reader', grants: { accounts: { setting: { actions: ['read'] } } } },
      { _id: 'ap_jv_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] } } } },
      {
        _id: 'ap_rates_clerk',
        name: 'Rates clerk',
        grants: { accounts: { setting: { actions: ['read', 'update'], fieldAccess: { currencies: 'read', exchangeRates: 'edit', taxRates: 'hidden', standInApproverId: 'hidden', standInUntil: 'hidden' } } } },
      },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rita', { profileId: 'ap_settings_reader' });
    await addPerson('nadia', { profileId: 'ap_jv_approver' });
    await addPerson('jamal', { profileId: 'ap_jv_approver', status: 'inactive' });
    await addPerson('kamrul');
    await addPerson('rafi', { profileId: 'ap_rates_clerk' });
  });

  it('needs a token, and the read or update permission', async () => {
    expect((await request(app).get(BASE)).status).toBe(401);
    expect((await (await as('kamrul')).get(BASE)).status).toBe(403);
    const rita = await as('rita');
    expect((await rita.get(BASE)).status).toBe(200);
    expect((await rita.patch(BASE, { taxRates: [] })).status).toBe(403);
    expect((await rita.get(`${BASE}/approver-candidates`)).status).toBe(403);
  });

  it('hides and locks each part as the profile says', async () => {
    const farhana = await as('farhana');
    await farhana.patch(BASE, { currencies: [{ code: 'USD', name: 'US dollar' }], taxRates: [{ code: 'VAT15', name: 'VAT', basisPoints: 1_500 }] });
    const rafi = await as('rafi');
    const seen = await rafi.get(BASE);
    expect(seen.status).toBe(200);
    expect(seen.body.currencies).toEqual([{ code: 'USD', name: 'US dollar' }]);
    expect(seen.body).not.toHaveProperty('taxRates');
    expect(seen.body).not.toHaveProperty('standInApprover');
    expect(seen.body).not.toHaveProperty('isStandInActive');

    const rate = { currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 12_250 };
    const saved = await rafi.patch(BASE, { exchangeRates: [rate] });
    expect(saved.status).toBe(200);
    expect(saved.body.exchangeRates).toEqual([rate]);
    expect(saved.body).not.toHaveProperty('taxRates');
    for (const body of [{ currencies: [] }, { taxRates: [] }, { standInApproverId: null }]) {
      const refused = await rafi.patch(BASE, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('field_not_editable');
    }
  });

  it('starts empty', async () => {
    const response = await (await as('farhana')).get(BASE);
    expect(response.body).toMatchObject({ standInApprover: null, isStandInActive: false, currencies: [], exchangeRates: [], taxRates: [], version: 0 });
  });

  it('saves rates and a stand-in, newest rate first, with history and an activity log entry', async () => {
    const farhana = await as('farhana');
    const saved = await farhana.patch(BASE, {
      standInApproverId: 'nadia',
      standInUntil: '2999-12-31',
      currencies: [{ code: 'USD', name: 'US dollar' }, { code: 'EUR', name: 'Euro' }, { code: 'USDT', name: 'Tether' }],
      exchangeRates: [
        { currency: 'USD', effectiveFrom: '2026-10-01', paisaPerUnit: 12_150 },
        { currency: 'EUR', effectiveFrom: '2026-11-01', paisaPerUnit: 13_100 },
        { currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 12_250 },
      ],
      taxRates: [{ code: 'VAT15', name: 'VAT 15%', basisPoints: 1_500 }],
      version: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      standInApprover: { id: 'nadia', name: 'Person nadia' },
      isStandInActive: true,
      currencies: [{ code: 'EUR', name: 'Euro' }, { code: 'USD', name: 'US dollar' }, { code: 'USDT', name: 'Tether' }],
      exchangeRates: [
        { currency: 'EUR', effectiveFrom: '2026-11-01', paisaPerUnit: 13_100 },
        { currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 12_250 },
        { currency: 'USD', effectiveFrom: '2026-10-01', paisaPerUnit: 12_150 },
      ],
      version: 1,
    });
    expect(await AuditLog.exists({ action: 'setting.updated', module: 'accounts' })).toBeTruthy();
  });

  it('refuses removing a currency that still has rates, and allows it once they are gone', async () => {
    const farhana = await as('farhana');
    await farhana.patch(BASE, { currencies: [{ code: 'USD', name: 'US dollar' }], exchangeRates: [{ currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 12_250 }] });
    const refused = await farhana.patch(BASE, { currencies: [] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields[0].path).toBe('currencies');
    expect((await farhana.patch(BASE, { currencies: [], exchangeRates: [] })).status).toBe(200);
  });

  it('clears the end date along with the stand-in', async () => {
    const farhana = await as('farhana');
    await farhana.patch(BASE, { standInApproverId: 'nadia', standInUntil: '2999-12-31' });
    const cleared = await farhana.patch(BASE, { standInApproverId: null });
    expect(cleared.body).toMatchObject({ standInApprover: null, isStandInActive: false });
    expect(cleared.body.standInUntil).toBeUndefined();
  });

  it.each([
    ['a stand-in who cannot open journal vouchers', { standInApproverId: 'rita' }, 'standInApproverId'],
    ['an inactive stand-in', { standInApproverId: 'jamal' }, 'standInApproverId'],
    ['an end date with no stand-in', { standInUntil: '2026-12-31' }, 'standInUntil'],
    ['the same currency twice', { currencies: [{ code: 'USD', name: 'A' }, { code: 'USD', name: 'B' }] }, 'currencies.1'],
    ['a rate for a currency not in the list', { exchangeRates: [{ currency: 'GBP', effectiveFrom: '2026-11-01', paisaPerUnit: 15_000 }] }, 'exchangeRates.0.currency'],
    ['the same currency and date twice', { currencies: [{ code: 'USD', name: 'US dollar' }], exchangeRates: [{ currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 1 }, { currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 2 }] }, 'exchangeRates.1'],
    ['the same tax code twice', { taxRates: [{ code: 'VAT', name: 'A', basisPoints: 1 }, { code: 'VAT', name: 'B', basisPoints: 2 }] }, 'taxRates.1'],
  ])('refuses %s', async (_label, body, path) => {
    const response = await (await as('farhana')).patch(BASE, body);
    expect(response.status).toBe(422);
    expect(response.body.error.fields[0].path).toBe(path);
  });

  it.each([
    ['a rate in decimals', { exchangeRates: [{ currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 122.5 }] }],
    ['taka as a currency', { currencies: [{ code: 'BDT', name: 'Taka' }] }],
    ['a lower-case currency code', { currencies: [{ code: 'usd', name: 'US dollar' }] }],
    ['a currency code shorter than 3 letters', { currencies: [{ code: 'US', name: 'US dollar' }] }],
    ['a currency with no name', { currencies: [{ code: 'USD', name: ' ' }] }],
    ['a tax rate above 100%', { taxRates: [{ code: 'VAT', name: 'VAT', basisPoints: 10_001 }] }],
    ['a lower-case tax code', { taxRates: [{ code: 'vat', name: 'VAT', basisPoints: 1_500 }] }],
  ])('refuses %s', async (_label, body) => {
    expect((await (await as('farhana')).patch(BASE, body)).status).toBe(422);
  });

  it('refuses a change made from an old copy', async () => {
    const farhana = await as('farhana');
    await farhana.patch(BASE, { taxRates: [], version: 0 });
    expect((await farhana.patch(BASE, { taxRates: [], version: 0 })).status).toBe(409);
  });

  it('offers active people who can open journal vouchers as stand-ins', async () => {
    const response = await (await as('farhana')).get(`${BASE}/approver-candidates`);
    expect(response.body.people.map((person: { id: string }) => person.id).sort()).toEqual(['farhana', 'nadia']);
  });

  it('treats the end date as the last day the stand-in may approve', () => {
    expect(isStandInActive({ standInApproverId: 'nadia', standInUntil: '2026-11-19' }, '2026-11-19')).toBe(true);
    expect(isStandInActive({ standInApproverId: 'nadia', standInUntil: '2026-11-19' }, '2026-11-20')).toBe(false);
    expect(isStandInActive({ standInApproverId: 'nadia' }, '2099-01-01')).toBe(true);
    expect(isStandInActive({}, '2026-11-19')).toBe(false);
  });
});
