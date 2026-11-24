import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactHistory, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { listRecordHistory, writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { Vendor, type VendorCategory, type VendorDoc } from '../models/vendor.js';

const VENDOR_RESOURCE = 'vendor';

export interface VendorDetails {
  name: string;
  category: VendorCategory;
  tdsBasisPoints: number;
  contactEmail?: string;
  contactPhone?: string;
}

/** For the optional contact details, null clears them. */
export type VendorChanges = Partial<Pick<VendorDetails, 'name' | 'category' | 'tdsBasisPoints'>> & {
  contactEmail?: string | null;
  contactPhone?: string | null;
  isActive?: boolean;
};

export interface VendorListFilter {
  category?: VendorCategory;
  isActive?: boolean;
  search?: string;
}

export const vendorNotFound = () => new ApiError(404, 'unknown_vendor', 'No such vendor.');

const historyRef = (vendorId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: VENDOR_RESOURCE, recordId: vendorId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, VENDOR_RESOURCE);

const toVendorView = (vendor: VendorDoc, rules: FieldRules) => redactRecord({
  id: vendor._id,
  name: vendor.name,
  category: vendor.category,
  tdsBasisPoints: vendor.tdsBasisPoints,
  contactEmail: vendor.contactEmail,
  contactPhone: vendor.contactPhone,
  isActive: vendor.isActive,
  version: vendor.version,
  updatedAt: vendor.updatedAt,
}, rules);

const auditFields = (actor: Actor, vendor: VendorDoc) => ({ ...actorFields(actor), targetType: VENDOR_RESOURCE, targetId: vendor._id, targetName: vendor.name, module: ACCOUNTS_MODULE_KEY });

export const findVendorById = (vendorId: string) => Vendor.findById(vendorId).lean();

export async function listVendors(actor: Actor, { category, isActive, search, ...page }: PageRequest & VendorListFilter) {
  const filter = {
    ...(category && { category }),
    ...(isActive !== undefined && { isActive }),
    ...(search && { name: { $regex: escapeRegex(search), $options: 'i' } }),
  };
  const [vendors, total, rules] = await Promise.all([
    Vendor.find(filter).sort({ name: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Vendor.countDocuments(filter),
    fieldRulesFor(actor),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, vendors: vendors.map((vendor) => toVendorView(vendor, rules)) };
}

export async function getVendor(actor: Actor, vendorId: string) {
  const vendor = await findVendorById(vendorId);
  if (!vendor) throw vendorNotFound();
  return toVendorView(vendor, await fieldRulesFor(actor));
}

export async function createVendor(actor: Actor, details: VendorDetails) {
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');
  const vendor = await runInTransaction(async (session) => {
    const [created] = await Vendor.create([{ _id: `vn_${randomUUID()}`, ...details, isActive: true, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the vendor returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'vendor.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  return toVendorView(vendor, rules);
}

export async function updateVendor(actor: Actor, vendorId: string, request: VendorChanges & { version?: number }) {
  const { version, ...changes } = request;
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  const existing = await findVendorById(vendorId);
  if (!existing) throw vendorNotFound();

  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) $unset[field] = 1;
    else if (value !== undefined) $set[field] = value;
  }
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(Vendor, vendorId, { $set, ...(Object.keys($unset).length > 0 && { $unset }) }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session }, vendorNotFound);
    await writeRecordHistory(historyRef(vendorId), { action: 'updated', actor, before: existing, after }, session);
    await recordAudit({ action: 'vendor.updated', ...auditFields(actor, after) }, session);
    return after;
  });
  return toVendorView(saved, rules);
}

export async function getVendorHistory(actor: Actor, vendorId: string, page: PageRequest) {
  if (!(await findVendorById(vendorId))) throw vendorNotFound();
  const history = await listRecordHistory(historyRef(vendorId), page);
  return { ...history, entries: redactHistory(history.entries, await fieldRulesFor(actor)) };
}
