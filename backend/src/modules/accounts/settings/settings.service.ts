import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUserById } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { ACCOUNTS_SETTINGS_ID, HOME_CURRENCY, type AccountsSettingsDoc, type Currency, type ExchangeRate } from '../models/accountsSettings.js';
import { findApproverCandidates, findOrCreateSettings, saveSettings, type SettingsChanges } from './settings.repository.js';

const SETTINGS_RESOURCE = 'setting';

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, SETTINGS_RESOURCE);

const historyRef = { module: ACCOUNTS_MODULE_KEY, object: SETTINGS_RESOURCE, recordId: ACCOUNTS_SETTINGS_ID };

const invalidField = (path: string, message: string) => new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message }]);

/** Whether the named stand-in may approve today: someone is named, and the end date, if any, hasn't passed. */
export function isStandInActive(settings: Pick<AccountsSettingsDoc, 'standInApproverId' | 'standInUntil'>, today = todayAsEntryDate()): boolean {
  if (!settings.standInApproverId) return false;
  return !settings.standInUntil || today <= settings.standInUntil;
}

const defaultCurrencyOf = (settings: Pick<AccountsSettingsDoc, 'defaultCurrency'>) => settings.defaultCurrency ?? HOME_CURRENCY;

/** The currency a new document starts in, for features such as invoices and bills to offer first. */
export async function findDefaultCurrency(): Promise<string> {
  return defaultCurrencyOf(await findOrCreateSettings());
}

/** The person who may approve as a stand-in today, or undefined when nobody may. */
export async function findActiveStandInId(): Promise<string | undefined> {
  const settings = await findOrCreateSettings();
  return isStandInActive(settings) ? settings.standInApproverId : undefined;
}

/**
 * The settings as this person may see them. Each part is a field of the setting resource in the manifest, so a
 * profile can hide it on the Profiles screen. The stand-in's name and whether it applies today go with its field.
 */
async function toSettingsView(settings: AccountsSettingsDoc, rules: FieldRules) {
  const view = redactRecord(await toFullSettingsView(settings), rules);
  if (!rules.hidden.includes('standInApproverId')) return view;
  const withoutStandIn: Partial<typeof view> = { ...view };
  delete withoutStandIn.standInApprover;
  delete withoutStandIn.isStandInActive;
  return withoutStandIn;
}

async function toFullSettingsView(settings: AccountsSettingsDoc) {
  const standIn = settings.standInApproverId ? await findUserById(settings.standInApproverId) : null;
  return {
    standInApprover: settings.standInApproverId ? { id: settings.standInApproverId, name: standIn?.name } : null,
    standInUntil: settings.standInUntil,
    isStandInActive: isStandInActive(settings),
    homeCurrency: HOME_CURRENCY,
    currencies: [...settings.currencies].sort((first, second) => first.code.localeCompare(second.code)),
    defaultCurrency: defaultCurrencyOf(settings),
    // By currency, then newest first, which is how people read a list of rates.
    exchangeRates: [...settings.exchangeRates].sort(
      (first, second) => first.currency.localeCompare(second.currency) || second.effectiveFrom.localeCompare(first.effectiveFrom),
    ),
    taxRates: settings.taxRates,
    providentFundBasisPoints: settings.providentFundBasisPoints ?? 0,
    gratuityBasisPoints: settings.gratuityBasisPoints ?? 0,
    version: settings.version,
    updatedBy: settings.updatedBy,
    updatedAt: settings.updatedAt,
  };
}

export async function getSettings(actor: Actor) {
  return toSettingsView(await findOrCreateSettings(), await fieldRulesFor(actor));
}

/** People the settings may name as the stand-in approver. */
export async function listApproverCandidates() {
  const people = await findApproverCandidates();
  return { people: people.map((person) => ({ id: person._id, name: person.name, email: person.email })) };
}

function assertUnique(values: string[], path: string, label: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) throw invalidField(`${path}.${index}`, `${label} "${value}" is listed twice`);
    seen.add(value);
  });
}

/**
 * Every rate must name a currency in the list. When the list itself is being changed, the error points at the
 * currency being removed; otherwise at the rate naming an unknown one.
 */
function assertRatesNameKnownCurrencies(currencies: Currency[], rates: ExchangeRate[], isChangingCurrencies: boolean): void {
  const codes = new Set(currencies.map((currency) => currency.code));
  const index = rates.findIndex((rate) => !codes.has(rate.currency));
  if (index === -1) return;
  const missing = rates[index]?.currency;
  if (isChangingCurrencies) throw invalidField('currencies', `${missing} still has exchange rates; remove them first`);
  throw invalidField(`exchangeRates.${index}.currency`, `${missing} isn't one of the currencies; add it first`);
}

/**
 * The default must be the home currency or a listed one. When the list is being changed, the error points at the
 * currency being removed; otherwise at the default.
 */
function assertDefaultCurrencyIsKnown(currencies: Currency[], defaultCurrency: string, isChangingDefault: boolean): void {
  if (defaultCurrency === HOME_CURRENCY || currencies.some((currency) => currency.code === defaultCurrency)) return;
  if (isChangingDefault) throw invalidField('defaultCurrency', `${defaultCurrency} isn't one of the currencies; add it first`);
  throw invalidField('currencies', `${defaultCurrency} is the default currency; choose another default first`);
}

async function assertValidChanges(existing: AccountsSettingsDoc, changes: SettingsChanges): Promise<void> {
  if (changes.standInApproverId) {
    const candidates = await findApproverCandidates();
    if (!candidates.some((person) => person._id === changes.standInApproverId)) {
      throw invalidField('standInApproverId', 'must be an active person who can open journal vouchers');
    }
  }
  const standInAfter = changes.standInApproverId === undefined ? existing.standInApproverId : changes.standInApproverId;
  const untilAfter = changes.standInUntil === undefined ? existing.standInUntil : changes.standInUntil;
  if (untilAfter && !standInAfter) throw invalidField('standInUntil', 'needs a stand-in approver');

  if (changes.currencies) assertUnique(changes.currencies.map((currency) => currency.code), 'currencies', 'the currency');
  if (changes.exchangeRates) {
    assertUnique(changes.exchangeRates.map((rate) => `${rate.currency} from ${rate.effectiveFrom}`), 'exchangeRates', 'the rate');
  }
  assertRatesNameKnownCurrencies(changes.currencies ?? existing.currencies, changes.exchangeRates ?? existing.exchangeRates, changes.currencies !== undefined);
  assertDefaultCurrencyIsKnown(changes.currencies ?? existing.currencies, changes.defaultCurrency ?? defaultCurrencyOf(existing), changes.defaultCurrency !== undefined);
  if (changes.taxRates) assertUnique(changes.taxRates.map((rate) => rate.code), 'taxRates', 'the code');
}

/** Changes the settings. Lists of rates are replaced whole, so the caller sends the full list it wants kept. */
export async function updateSettings(actor: Actor, request: SettingsChanges & { version?: number }) {
  const { version, ...changes } = request;
  const rules = await fieldRulesFor(actor);
  // Checked on what was sent, before the end date is cleared along with the stand-in below.
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  // A stand-in's end date goes with the stand-in, so clearing the person clears the date too.
  if (changes.standInApproverId === null && changes.standInUntil === undefined) changes.standInUntil = null;

  const existing = await findOrCreateSettings();
  await assertValidChanges(existing, changes);

  const saved = await runInTransaction(async (session) => {
    const result = await saveSettings(changes, { actorId: actor.user._id, expectedVersion: version, session });
    await writeRecordHistory(historyRef, { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({
      action: 'setting.updated',
      ...actorFields(actor),
      targetType: SETTINGS_RESOURCE,
      targetId: ACCOUNTS_SETTINGS_ID,
      targetName: 'Accounts settings',
      module: ACCOUNTS_MODULE_KEY,
    }, session);
    return result;
  });
  return toSettingsView(saved, rules);
}
