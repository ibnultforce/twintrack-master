import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { escapeRegex, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { fieldRulesFor, invalidField, readRecordHistory, writeAccountsRecord, type ActiveStatus } from '../accountsModule.js';
import { findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { Vendor, type VendorDoc } from '../models/masterData.js';

const RESOURCE = 'vendor';

export const vendorNotFound = () => new ApiError(404, 'unknown_vendor', 'No such vendor.');

export interface VendorDetails {
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  bankName?: string;
  bankAccountNumber?: string;
  notes?: string;
}

export type VendorChanges = Partial<VendorDetails> & { status?: ActiveStatus; version?: number };

/** Vendors who can be billed or paid now. */
export async function assertActiveVendor(vendorId: string, path = 'vendorId'): Promise<VendorDoc> {
  const vendor = await Vendor.findById(vendorId).lean();
  if (!vendor) throw invalidField(path, 'no such vendor');
  if (vendor.status !== 'active') throw invalidField(path, 'is inactive');
  return vendor;
}

export async function findVendorNames(vendorIds: (string | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(vendorIds.filter((id): id is string => Boolean(id)))];
  const vendors = await Vendor.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(vendors.map((vendor) => [vendor._id, vendor.name]));
}

/** Vendors, with the bank account number decrypted and stored under its plain name, as field access knows it. */
export function createVendorService(cipher: SecretCipher) {
  const toView = (vendor: VendorDoc, rules: FieldRules) =>
    redactRecord(
      {
        id: vendor._id,
        name: vendor.name,
        contactName: vendor.contactName,
        contactEmail: vendor.contactEmail,
        contactPhone: vendor.contactPhone,
        address: vendor.address,
        bankName: vendor.bankName,
        bankAccountNumber: vendor.bankAccountNumberEncrypted ? cipher.decrypt(vendor.bankAccountNumberEncrypted) : undefined,
        notes: vendor.notes,
        status: vendor.status,
        version: vendor.version,
        createdBy: vendor.createdBy,
        createdAt: vendor.createdAt,
        updatedBy: vendor.updatedBy,
        updatedAt: vendor.updatedAt,
      },
      rules,
    );

  /** The stored form of the details: the account number encrypted, an empty one removed. */
  function toStored({ bankAccountNumber, ...plain }: Partial<VendorDetails>) {
    if (bankAccountNumber === undefined) return { $set: plain };
    return bankAccountNumber
      ? { $set: { ...plain, bankAccountNumberEncrypted: cipher.encrypt(bankAccountNumber) } }
      : { $set: plain, $unset: { bankAccountNumberEncrypted: 1 } };
  }

  async function listVendors(actor: Actor, query: PageRequest & { status?: ActiveStatus; search?: string }) {
    const { status, search, ...page } = query;
    const filter = { ...(status && { status }), ...(search && { name: { $regex: escapeRegex(search), $options: 'i' } }) };
    const { records, total } = await findRecordPage(Vendor, filter, page, { name: 1 });
    const rules = await fieldRulesFor(actor, RESOURCE);
    return { total, vendors: records.map((vendor) => toView(vendor, rules)) };
  }

  async function getVendor(actor: Actor, vendorId: string) {
    return toView(await requireRecord(Vendor, vendorId, vendorNotFound), await fieldRulesFor(actor, RESOURCE));
  }

  async function createVendor(actor: Actor, details: VendorDetails) {
    const rules = await fieldRulesFor(actor, RESOURCE);
    assertMayWriteFields(rules, Object.keys(details), 'create');
    const created = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'vendor.created',
      write: (session) => insertRecord<VendorDoc>(Vendor, { _id: `ven_${randomUUID()}`, ...toStored(details).$set }, actor.user._id, session),
      label: (vendor) => vendor.name,
    });
    return toView(created, rules);
  }

  async function updateVendor(actor: Actor, vendorId: string, changes: VendorChanges) {
    const { version, status, ...details } = changes;
    const existing = await requireRecord(Vendor, vendorId, vendorNotFound);
    const rules = await fieldRulesFor(actor, RESOURCE);
    assertMayWriteFields(rules, Object.keys({ ...details, ...(status && { status }) }), 'update');
    const stored = toStored(details);
    const saved = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: status && status !== existing.status ? `vendor.${status === 'active' ? 'reactivated' : 'deactivated'}` : 'vendor.updated',
      before: existing,
      write: (session) =>
        changeRecord(Vendor, vendorId, { ...stored, $set: { ...stored.$set, ...(status && { status }) } }, { actorId: actor.user._id, expectedVersion: version, session }, vendorNotFound),
      label: (vendor) => vendor.name,
    });
    return toView(saved, rules);
  }

  async function getVendorHistory(actor: Actor, vendorId: string, page: PageRequest) {
    await requireRecord(Vendor, vendorId, vendorNotFound);
    return readRecordHistory(actor, RESOURCE, vendorId, page);
  }

  return { listVendors, getVendor, createVendor, updateVendor, getVendorHistory };
}
