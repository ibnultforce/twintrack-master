import { ApiError } from '../../../lib/errors.js';
import { HOME_CURRENCY, type ExchangeRate } from '../models/accountsSettings.js';
import { findOrCreateSettings } from '../settings/settings.repository.js';

/** Every currency is kept in hundredths (paisa, cents), so one unit is 100 minor units. */
const MINOR_UNITS_PER_UNIT = 100;

/** Paisa per unit of the home currency: one taka is 100 paisa. */
export const HOME_RATE = MINOR_UNITS_PER_UNIT;

/**
 * Converts an amount in a currency's minor units (cents) to paisa at a rate in paisa per unit, rounding half away
 * from zero to the nearest paisa. This is the one place a currency amount is rounded into taka.
 */
export function toPaisa(minorAmount: number, paisaPerUnit: number): number {
  const exact = (minorAmount * paisaPerUnit) / MINOR_UNITS_PER_UNIT;
  return Math.sign(exact) * Math.round(Math.abs(exact));
}

/** The rate in force on a date: the newest one from that date or earlier. */
export function pickRate(rates: ExchangeRate[], currency: string, date: string): ExchangeRate | undefined {
  return rates
    .filter((rate) => rate.currency === currency && rate.effectiveFrom <= date)
    .sort((first, second) => second.effectiveFrom.localeCompare(first.effectiveFrom))[0];
}

/** Paisa per unit of `currency` on `date`. Taka is always 100. A currency with no rate yet is refused at `path`. */
export async function rateOn(currency: string, date: string, path: string): Promise<number> {
  if (currency === HOME_CURRENCY) return HOME_RATE;
  const settings = await findOrCreateSettings();
  if (!settings.currencies.some((listed) => listed.code === currency)) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path, message: `${currency} isn't one of the currencies in Settings` }]);
  }
  const rate = pickRate(settings.exchangeRates, currency, date);
  if (!rate) {
    throw new ApiError(422, 'no_exchange_rate', `There is no ${currency} rate on or before ${date}. Add one in Settings first.`, [{ path, message: `no ${currency} rate on or before ${date}` }]);
  }
  return rate.paisaPerUnit;
}
