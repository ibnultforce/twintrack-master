import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import type { Actor } from '../../master/access/caller.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import { fieldRulesFor, invalidField, readRecordHistory, writeAccountsRecord, type ActiveStatus } from '../accountsModule.js';
import { findRecordPage, insertRecord, requireRecord } from '../accountsFields.js';
import { Category, type CategoryDoc } from '../models/masterData.js';

const RESOURCE = 'category';

export const categoryNotFound = () => new ApiError(404, 'unknown_category', 'No such category.');

export interface CategoryDetails {
  name: string;
  code: string;
  parentId?: string;
}

const toView = (category: CategoryDoc, rules: FieldRules) =>
  redactRecord(
    {
      id: category._id,
      name: category.name,
      code: category.code,
      parentId: category.parentId,
      status: category.status,
      version: category.version,
      createdBy: category.createdBy,
      createdAt: category.createdAt,
      updatedBy: category.updatedBy,
      updatedAt: category.updatedAt,
    },
    rules,
  );

/** Codes are unique, so a clash is reported against the field. */
async function withUniqueCode<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ApiError(409, 'code_taken', 'Another category already uses that code.');
    throw error;
  }
}

/** A parent must exist, and can't be the category itself or below it, which would make a loop. */
async function assertValidParent(parentId: string | undefined, categoryId?: string): Promise<void> {
  if (!parentId) return;
  let current: string | undefined = parentId;
  while (current) {
    if (current === categoryId) throw invalidField('parentId', "can't be the category itself or one below it");
    const parent: CategoryDoc | null = await Category.findById(current).lean();
    if (!parent) throw invalidField('parentId', 'no such category');
    current = parent.parentId;
  }
}

/** A category money can be filed under now. Inactive ones stay on old records only. */
export async function assertActiveCategory(categoryId: string | undefined, path = 'categoryId'): Promise<void> {
  if (!categoryId) return;
  const category = await Category.findById(categoryId).lean();
  if (!category) throw invalidField(path, 'no such category');
  if (category.status !== 'active') throw invalidField(path, 'is inactive');
}

export async function listCategories(actor: Actor, query: PageRequest & { status?: ActiveStatus; search?: string }) {
  const { status, search, ...page } = query;
  const filter = {
    ...(status && { status }),
    ...(search && { $or: [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { code: { $regex: escapeRegex(search), $options: 'i' } }] }),
  };
  const { records, total } = await findRecordPage(Category, filter, page, { code: 1 });
  const rules = await fieldRulesFor(actor, RESOURCE);
  return { total, categories: records.map((category) => toView(category, rules)) };
}

export async function getCategory(actor: Actor, categoryId: string) {
  return toView(await requireRecord(Category, categoryId, categoryNotFound), await fieldRulesFor(actor, RESOURCE));
}

export async function createCategory(actor: Actor, details: CategoryDetails) {
  const rules = await fieldRulesFor(actor, RESOURCE);
  assertMayWriteFields(rules, Object.keys(details), 'create');
  await assertValidParent(details.parentId);
  const created = await withUniqueCode(() =>
    writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'category.created',
      write: (session) => insertRecord<CategoryDoc>(Category, { ...details, code: details.code.toUpperCase(), _id: `cat_${randomUUID()}` }, actor.user._id, session),
      label: (category) => category.code,
    }),
  );
  return toView(created, rules);
}

export async function updateCategory(actor: Actor, categoryId: string, changes: Partial<CategoryDetails> & { status?: ActiveStatus; version?: number }) {
  const { version, ...fields } = changes;
  const existing = await requireRecord(Category, categoryId, categoryNotFound);
  const rules = await fieldRulesFor(actor, RESOURCE);
  assertMayWriteFields(rules, Object.keys(fields), 'update');
  await assertValidParent(fields.parentId, categoryId);
  const saved = await withUniqueCode(() =>
    writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'category.updated',
      before: existing,
      write: (session) =>
        changeRecord(Category, categoryId, { $set: { ...fields, ...(fields.code && { code: fields.code.toUpperCase() }) } }, { actorId: actor.user._id, expectedVersion: version, session }, categoryNotFound),
      label: (category) => category.code,
    }),
  );
  return toView(saved, rules);
}

export async function getCategoryHistory(actor: Actor, categoryId: string, page: PageRequest) {
  await requireRecord(Category, categoryId, categoryNotFound);
  return readRecordHistory(actor, RESOURCE, categoryId, page);
}
