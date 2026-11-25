import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';

/** The one settings record. Its id never changes, so reads and writes always find it. */
export const ACCOUNTS_SETTINGS_ID = 'accounts';

/** The currency the books are kept in. Every ledger amount is in it, and it never needs an exchange rate. */
export const HOME_CURRENCY = 'BDT';

/** A foreign currency the company deals in. Exchange rates can name only these. */
export interface Currency {
  /** ISO 4217 code, such as USD. Never BDT, the home currency. */
  code: string;
  name: string;
}

/**
 * Taka per one unit of a foreign currency from a date onward, in paisa: USD at 12250 is 122.50 taka per dollar.
 * The books are kept in taka; a document in another currency uses that currency's rate on its date.
 */
export interface ExchangeRate {
  /** The code of one of the settings' currencies. */
  currency: string;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  paisaPerUnit: number;
}

/** A tax or VAT rate bills and invoices can apply, in basis points: 1500 is 15%. */
export interface TaxRate {
  code: string;
  name: string;
  basisPoints: number;
}

export interface AccountsSettingsDoc extends RecordFields {
  _id: string;
  /** Someone who may approve Accounts records while the usual approvers are away, without the approve permission. */
  standInApproverId?: string;
  /** The last day (YYYY-MM-DD) the stand-in may approve. Without it, the stand-in has no end date. */
  standInUntil?: string;
  currencies: Currency[];
  /**
   * The currency new documents, such as invoices and bills, start in: the home currency or one of `currencies`.
   * People can still pick another per document. Settings saved before it existed have none, which means the home currency.
   */
  defaultCurrency?: string;
  exchangeRates: ExchangeRate[];
  taxRates: TaxRate[];
  /**
   * Provident fund, in basis points of each person's gross pay: payroll takes this share from their pay, and the
   * company adds the same again. Missing or 0 means no provident fund.
   */
  providentFundBasisPoints?: number;
  /** Gratuity the company sets aside each month, in basis points of gross pay (833 is about a month's pay a year). Missing or 0 means none. */
  gratuityBasisPoints?: number;
}

const accountsSettingsSchema = new Schema<AccountsSettingsDoc>(
  {
    _id: { type: String, required: true },
    standInApproverId: String,
    standInUntil: String,
    currencies: {
      type: [new Schema<Currency>({ code: { type: String, required: true }, name: { type: String, required: true } }, { _id: false })],
      default: [],
    },
    defaultCurrency: String,
    exchangeRates: {
      type: [
        new Schema<ExchangeRate>(
          { currency: { type: String, required: true }, effectiveFrom: { type: String, required: true }, paisaPerUnit: { type: Number, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    taxRates: {
      type: [new Schema<TaxRate>({ code: { type: String, required: true }, name: { type: String, required: true }, basisPoints: { type: Number, required: true } }, { _id: false })],
      default: [],
    },
    providentFundBasisPoints: Number,
    gratuityBasisPoints: Number,
  },
  { timestamps: true },
);

addRecordFields(accountsSettingsSchema);

export const AccountsSettings = model<AccountsSettingsDoc>('AccountsSettings', accountsSettingsSchema, 'accounts_settings');
