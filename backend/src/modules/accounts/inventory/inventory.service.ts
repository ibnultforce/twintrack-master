import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { assertMayWriteFields, readFieldRules, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { InventoryItem, InventoryMovement, type InventoryItemDoc, type MovementKind } from '../models/inventoryItem.js';

const ITEM_RESOURCE = 'inventoryItem';
/** Quantities keep 3 decimals; sums are rounded to that, so 0.1 + 0.2 reads as 0.3. */
const QUANTITY_SCALE = 1000;

export interface InventoryItemDetails {
  name: string;
  assetTag?: string;
  category: string;
  unit: string;
  reorderLevel?: number;
}

export interface NewMovement {
  date: string;
  kind: MovementKind;
  quantity: number;
  note?: string;
  reference?: string;
}

export const inventoryItemNotFound = () => new ApiError(404, 'unknown_inventory_item', 'No such inventory item.');

const historyRef = (itemId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: ITEM_RESOURCE, recordId: itemId });

const fieldRulesFor = (actor: Actor) => readFieldRules(actor, ACCOUNTS_MODULE_KEY, ITEM_RESOURCE);

const roundQuantity = (quantity: number) => Math.round(quantity * QUANTITY_SCALE) / QUANTITY_SCALE;

/** How a movement changes the count: in adds, out takes away, adjust is already signed. */
const signedQuantity = (kind: MovementKind, quantity: number) => (kind === 'out' ? -quantity : quantity);

/** Stock on hand per item, worked out from its movements: never typed in, never stored. */
async function sumOnHand(itemIds: string[]): Promise<Map<string, number>> {
  const rows = await InventoryMovement.aggregate<{ _id: string; onHand: number }>([
    { $match: { itemId: { $in: itemIds } } },
    { $group: { _id: '$itemId', onHand: { $sum: { $cond: [{ $eq: ['$kind', 'out'] }, { $multiply: ['$quantity', -1] }, '$quantity'] } } } },
  ]);
  return new Map(rows.map((row) => [row._id, roundQuantity(row.onHand)]));
}

async function viewsOf(items: InventoryItemDoc[], rules: FieldRules) {
  const onHand = await sumOnHand(items.map((item) => item._id));
  return items.map((item) => {
    const quantity = onHand.get(item._id) ?? 0;
    return redactRecord({
      id: item._id,
      name: item.name,
      assetTag: item.assetTag,
      category: item.category,
      unit: item.unit,
      reorderLevel: item.reorderLevel,
      onHand: quantity,
      isLow: item.reorderLevel !== undefined && quantity <= item.reorderLevel,
      isActive: item.isActive,
      version: item.version,
      updatedAt: item.updatedAt,
    }, rules);
  });
}

async function requireItem(itemId: string): Promise<InventoryItemDoc> {
  const item = await InventoryItem.findById(itemId).lean();
  if (!item) throw inventoryItemNotFound();
  return item;
}

const auditFields = (actor: Actor, item: InventoryItemDoc) => ({ ...actorFields(actor), targetType: ITEM_RESOURCE, targetId: item._id, targetName: item.name, module: ACCOUNTS_MODULE_KEY });

export async function listInventoryItems(actor: Actor, { isActive, search, ...page }: PageRequest & { isActive?: boolean; search?: string }) {
  const filter = {
    ...(isActive !== undefined && { isActive }),
    ...(search && { $or: [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { assetTag: { $regex: escapeRegex(search), $options: 'i' } }, { category: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
  const [items, total, rules] = await Promise.all([
    InventoryItem.find(filter).sort({ name: 1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    InventoryItem.countDocuments(filter),
    fieldRulesFor(actor),
  ]);
  return { total, page: page.page, pageSize: page.pageSize, items: await viewsOf(items, rules) };
}

/** One item with its stock movements, newest first. */
export async function getInventoryItem(actor: Actor, itemId: string) {
  const item = await requireItem(itemId);
  const [[view], movements] = await Promise.all([
    viewsOf([item], await fieldRulesFor(actor)),
    InventoryMovement.find({ itemId }).sort({ date: -1, createdAt: -1 }).lean(),
  ]);
  const names = new Map((await findUsersByIds([...new Set(movements.map((movement) => movement.createdBy))])).map((person) => [person._id, person.name]));
  return {
    ...view,
    movements: movements.map((movement) => ({
      id: movement._id,
      date: movement.date,
      kind: movement.kind,
      quantity: movement.quantity,
      note: movement.note,
      reference: movement.reference,
      createdBy: { id: movement.createdBy, name: names.get(movement.createdBy) },
      createdAt: movement.createdAt,
    })),
  };
}

export async function createInventoryItem(actor: Actor, details: InventoryItemDetails) {
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(details), 'create');
  const item = await runInTransaction(async (session) => {
    const [created] = await InventoryItem.create([{ _id: `ii_${randomUUID()}`, ...details, isActive: true, createdBy: actor.user._id, updatedBy: actor.user._id }], { session });
    if (!created) throw new Error('Creating the inventory item returned nothing.');
    const saved = created.toObject();
    await writeRecordHistory(historyRef(saved._id), { action: 'created', actor, after: saved }, session);
    await recordAudit({ action: 'inventoryItem.created', ...auditFields(actor, saved) }, session);
    return saved;
  });
  const [view] = await viewsOf([item], rules);
  return view;
}

/** For the optional fields, null clears them. */
export async function updateInventoryItem(
  actor: Actor,
  itemId: string,
  request: Partial<Pick<InventoryItemDetails, 'name' | 'category' | 'unit'>> & { assetTag?: string | null; reorderLevel?: number | null; isActive?: boolean; version?: number },
) {
  const { version, ...changes } = request;
  const rules = await fieldRulesFor(actor);
  assertMayWriteFields(rules, Object.keys(changes), 'update');
  const existing = await requireItem(itemId);
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) $unset[field] = 1;
    else if (value !== undefined) $set[field] = value;
  }
  const saved = await runInTransaction(async (session) => {
    const after = await changeRecord(InventoryItem, itemId, { $set, ...(Object.keys($unset).length > 0 && { $unset }) }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session }, inventoryItemNotFound);
    await writeRecordHistory(historyRef(itemId), { action: 'updated', actor, before: existing, after }, session);
    await recordAudit({ action: 'inventoryItem.updated', ...auditFields(actor, after) }, session);
    return after;
  });
  const [view] = await viewsOf([saved], rules);
  return view;
}

/**
 * Records stock coming in, going out, or a count correction. Stock can't go below zero, and an inactive item takes
 * no movements. Checked and saved in one transaction, so two issues at once can't both take the last one.
 */
export async function addMovement(actor: Actor, itemId: string, movement: NewMovement) {
  const item = await requireItem(itemId);
  if (!item.isActive) throw new ApiError(409, 'inventory_item_inactive', `${item.name} is inactive, so its stock can't change.`);
  if (movement.kind !== 'adjust' && movement.quantity <= 0) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'quantity', message: 'must be above zero; use an adjustment to lower a count' }]);
  }
  if (movement.kind === 'adjust' && movement.quantity === 0) {
    throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'quantity', message: 'an adjustment must change the count' }]);
  }
  await runInTransaction(async (session) => {
    // Locks the item for this transaction, so concurrent movements on it run one after another.
    await InventoryItem.updateOne({ _id: itemId }, { $inc: { version: 0 } }, { session });
    const rows = await InventoryMovement.find({ itemId }).session(session).select('kind quantity').lean();
    const before = roundQuantity(rows.reduce((sum, row) => sum + signedQuantity(row.kind, row.quantity), 0));
    const after = roundQuantity(before + signedQuantity(movement.kind, movement.quantity));
    if (after < 0) {
      throw new ApiError(422, 'not_enough_stock', `Only ${before} ${item.unit} of ${item.name} on hand.`, [{ path: 'quantity', message: `must be at most ${before}` }]);
    }
    await InventoryMovement.create([{ _id: `im_${randomUUID()}`, itemId, ...movement, createdBy: actor.user._id, createdAt: new Date() }], { session });
    await recordAudit({ action: `inventoryItem.stock${movement.kind === 'in' ? 'In' : movement.kind === 'out' ? 'Out' : 'Adjusted'}`, ...auditFields(actor, item) }, session);
  });
  return getInventoryItem(actor, itemId);
}
