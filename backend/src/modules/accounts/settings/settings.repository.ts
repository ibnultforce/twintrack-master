import type { ClientSession } from 'mongoose';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { ApiError } from '../../../lib/errors.js';
import { AccessProfile } from '../../master/models/accessProfile.js';
import { User, type UserDoc } from '../../master/models/user.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { ACCOUNTS_SETTINGS_ID, AccountsSettings, type AccountsSettingsDoc } from '../models/accountsSettings.js';

export type SettingsChanges = Partial<Pick<AccountsSettingsDoc, 'currencies' | 'defaultCurrency' | 'exchangeRates' | 'taxRates' | 'providentFundBasisPoints' | 'gratuityBasisPoints'>> & {
  /** null clears it. */
  standInApproverId?: string | null;
  standInUntil?: string | null;
};

const settingsNotFound = () => new ApiError(404, 'unknown_settings', 'The Accounts settings are missing.');

/** The settings record, created empty the first time anyone reads it, so every caller can rely on it existing. */
export async function findOrCreateSettings(session?: ClientSession): Promise<AccountsSettingsDoc> {
  const settings = await AccountsSettings.findOneAndUpdate(
    { _id: ACCOUNTS_SETTINGS_ID },
    { $setOnInsert: { currencies: [], exchangeRates: [], taxRates: [], version: 0 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean<AccountsSettingsDoc>();
  if (!settings) throw new Error('Reading the Accounts settings returned nothing.');
  return settings;
}

export function saveSettings(changes: SettingsChanges, context: { actorId: string; expectedVersion?: number; session: ClientSession }) {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) $unset[field] = 1;
    else if (value !== undefined) $set[field] = value;
  }
  return changeRecord(AccountsSettings, ACCOUNTS_SETTINGS_ID, { $set, ...(Object.keys($unset).length > 0 && { $unset }) }, context, settingsNotFound);
}

/**
 * Active people who can open journal vouchers: super admins, and holders of a profile that grants anything on them.
 * Only they can reach an approval, so only they make sense as a stand-in.
 */
export async function findApproverCandidates(): Promise<Pick<UserDoc, '_id' | 'name' | 'email'>[]> {
  const profileIds = await AccessProfile.find({ [`grants.${ACCOUNTS_MODULE_KEY}.journalVoucher`]: { $exists: true } }).distinct('_id');
  return User.find({ status: 'active', $or: [{ superAdmin: true }, { profileId: { $in: profileIds } }] })
    .select({ name: 1, email: 1 })
    .sort({ name: 1 })
    .lean();
}
