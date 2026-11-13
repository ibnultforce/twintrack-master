import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';
import type { ApiError } from '../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../lib/query.js';
import type { RecordFields } from '../../lib/records/recordFields.js';
import { ACTIVE_STATUSES, CURRENCIES, TRANSACTION_METHODS } from './accountsModule.js';

/** Request fields every Accounts route checks the same way. */

const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_SHORT_TEXT_LENGTH = 200;
export const MAX_TEXT_LENGTH = 5000;
/** Larger than any real amount, to catch a mistyped one. */
const MAX_AMOUNT = 1_000_000_000_000;

export const idField = z.string().trim().min(1, 'is required').max(MAX_ID_LENGTH);
export const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
export const shortTextField = z.string().trim().max(MAX_SHORT_TEXT_LENGTH);
export const textField = z.string().trim().max(MAX_TEXT_LENGTH);
export const requiredTextField = z.string().trim().min(1, 'is required').max(MAX_TEXT_LENGTH);
export const emailField = z.email('must be an email address').max(MAX_NAME_LENGTH);
export const amountField = z.number().min(0, 'can not be below zero').max(MAX_AMOUNT);
export const positiveAmountField = z.number().positive('must be above zero').max(MAX_AMOUNT);
/** Allows for floating point, so 10.1 counts as whole cents. */
const CENT_EPSILON = 1e-6;
const isWholeCents = (amount: number) => Math.abs(amount * 100 - Math.round(amount * 100)) < CENT_EPSILON;
const wholeCentsMessage = 'can have at most two decimal places';
/** Money is kept to the cent, so an amount finer than that is refused rather than rounded out of sight. */
export const moneyField = amountField.refine(isWholeCents, wholeCentsMessage);
export const positiveMoneyField = positiveAmountField.refine(isWholeCents, wholeCentsMessage);
export const dateField = z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value));
export const versionField = z.number().int().min(0);
export const currencyField = z.enum(CURRENCIES);
export const methodField = z.enum(TRANSACTION_METHODS);
export const activeStatusField = z.enum(ACTIVE_STATUSES);
export const monthField = z.coerce.number().int().min(1).max(12);
export const yearField = z.coerce.number().int().min(2000).max(2100);

/** The first and last day of a period, both counted, checked to be in order. */
export const periodFields = { from: dateField, to: dateField };
export const isPeriodInOrder = ({ from, to }: { from: Date; to: Date }) => from <= to;
export const periodOrderMessage = { message: 'from must be on or before to', path: ['to'] };

/** A body that changes something must change at least one field, besides the version it read. */
export const changesSomething = ({ version: _version, ...changes }: { version?: number }) => Object.keys(changes).length > 0;
export const changesSomethingMessage = { message: 'send at least one field to change' };

const DAY_MS = 86_400_000;
/** The moment after a period's last day, for queries that end before it. */
export const endOfDay = (day: Date) => new Date(day.getTime() + DAY_MS);

/** One page of records, newest first unless a sort is given. */
export async function findRecordPage<Doc extends RecordFields>(model: Model<Doc>, filter: Record<string, unknown>, page: PageRequest, sort: Record<string, 1 | -1> = { createdAt: -1 }) {
  const [records, total] = await Promise.all([
    model.find(filter).sort({ ...sort, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean<Doc[]>(),
    model.countDocuments(filter),
  ]);
  return { records, total };
}

export async function requireRecord<Doc extends RecordFields>(model: Model<Doc>, recordId: string, notFound: () => ApiError): Promise<Doc> {
  const record = await model.findById(recordId).lean<Doc>();
  if (!record) throw notFound();
  return record;
}

export async function insertRecord<Doc extends RecordFields>(model: Model<Doc>, record: object, actorId: string, session: ClientSession): Promise<Doc> {
  const created = await new model({ ...record, createdBy: actorId, updatedBy: actorId }).save({ session });
  return created.toObject() as Doc;
}
