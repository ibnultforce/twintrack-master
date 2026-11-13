import { Schema, model } from 'mongoose';
import { addRecordFields, type RecordFields } from '../../../lib/records/recordFields.js';
import { ACTIVE_STATUSES, CURRENCIES, type ActiveStatus, type Currency } from '../accountsModule.js';

/**
 * The lists money is filed against: categories of income and spending, vendors who bill the company, and the
 * company's own bank accounts. None is ever deleted, because posted money names them; they're made inactive instead.
 */

export interface CategoryDoc extends RecordFields {
  _id: string;
  name: string;
  /** Short and unique, such as OFFICE-RENT, for reports and imports. */
  code: string;
  parentId?: string;
  status: ActiveStatus;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    parentId: { type: String, index: true },
    status: { type: String, enum: ACTIVE_STATUSES, default: 'active' },
  },
  { timestamps: true },
);
addRecordFields(categorySchema);
export const Category = model<CategoryDoc>('AccountsCategory', categorySchema, 'accounts_categories');

export interface VendorDoc extends RecordFields {
  _id: string;
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  bankName?: string;
  /** Encrypted with ENCRYPTION_KEY. The API shows it only to people whose field access reaches it. */
  bankAccountNumberEncrypted?: string;
  notes?: string;
  status: ActiveStatus;
}

const vendorSchema = new Schema<VendorDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    contactName: String,
    contactEmail: String,
    contactPhone: String,
    address: String,
    bankName: String,
    bankAccountNumberEncrypted: String,
    notes: String,
    status: { type: String, enum: ACTIVE_STATUSES, default: 'active' },
  },
  { timestamps: true },
);
addRecordFields(vendorSchema);
export const Vendor = model<VendorDoc>('AccountsVendor', vendorSchema, 'accounts_vendors');

export interface BankAccountDoc extends RecordFields {
  _id: string;
  name: string;
  bankName?: string;
  accountNumberEncrypted?: string;
  /** Every payment and receipt through this account is in this currency. */
  currency: Currency;
  /** The balance on openingDate. The current balance is worked out from money in and out since, never stored. */
  openingBalance: number;
  openingDate: Date;
  status: ActiveStatus;
}

const bankAccountSchema = new Schema<BankAccountDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    bankName: String,
    accountNumberEncrypted: String,
    currency: { type: String, enum: CURRENCIES, required: true },
    openingBalance: { type: Number, default: 0 },
    openingDate: { type: Date, required: true },
    status: { type: String, enum: ACTIVE_STATUSES, default: 'active' },
  },
  { timestamps: true },
);
addRecordFields(bankAccountSchema);
export const BankAccount = model<BankAccountDoc>('AccountsBankAccount', bankAccountSchema, 'accounts_bank_accounts');

/** The one set of payment details printed on every invoice. */
export const COMPANY_BANK_DETAILS_ID = 'company';

export interface CompanyBankDetailsDoc extends RecordFields {
  _id: typeof COMPANY_BANK_DETAILS_ID;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  branchName?: string;
  routingNumber?: string;
  swiftCode?: string;
  address?: string;
}

const companyBankDetailsSchema = new Schema<CompanyBankDetailsDoc>(
  {
    _id: { type: String, required: true },
    bankName: String,
    accountName: String,
    accountNumber: String,
    branchName: String,
    routingNumber: String,
    swiftCode: String,
    address: String,
  },
  { timestamps: true },
);
addRecordFields(companyBankDetailsSchema);
export const CompanyBankDetails = model<CompanyBankDetailsDoc>('AccountsCompanyBankDetails', companyBankDetailsSchema, 'accounts_company_bank_details');
