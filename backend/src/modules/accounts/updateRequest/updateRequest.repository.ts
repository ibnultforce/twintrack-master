import type { ClientSession, UpdateQuery } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { VoucherCounter } from '../models/journalVoucher.js';
import { UpdateRequest, type CorrectableRecordType, type UpdateRequestDoc, type UpdateRequestStatus } from '../models/updateRequest.js';

export type NewUpdateRequestRecord = Pick<UpdateRequestDoc, '_id' | 'number' | 'recordType' | 'recordId' | 'recordNumber' | 'reason' | 'before' | 'after'>;

export const updateRequestNotFound = () => new ApiError(404, 'unknown_update_request', 'No such update request.');

const COUNTER_ID = 'updateRequest';

export interface UpdateRequestListFilter {
  status?: UpdateRequestStatus;
  /** Only requests about this record. */
  recordId?: string;
}

/** Only requests about record types the caller can read. */
type ReadableTypes = { recordTypes: CorrectableRecordType[] };

export async function findUpdateRequestsPage({ status, recordId, recordTypes, ...page }: PageRequest & UpdateRequestListFilter & ReadableTypes) {
  const filter = { recordType: { $in: recordTypes }, ...(status && { status }), ...(recordId && { recordId }) };
  const [requests, total] = await Promise.all([
    UpdateRequest.find(filter).sort({ createdAt: -1, number: -1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    UpdateRequest.countDocuments(filter),
  ]);
  return { requests, total };
}

/** Waiting requests, oldest first: those made by someone other than `notMadeBy`, or only those made by `madeBy`. */
export async function findWaitingUpdateRequests(creator: { notMadeBy: string } | { madeBy: string }, limit: number) {
  const filter = { status: 'waiting' as const, createdBy: 'madeBy' in creator ? creator.madeBy : { $ne: creator.notMadeBy } };
  const [requests, total] = await Promise.all([
    UpdateRequest.find(filter).sort({ createdAt: 1, number: 1 }).limit(limit).lean(),
    UpdateRequest.countDocuments(filter),
  ]);
  return { requests, total };
}

export interface UpdateRequestSummary {
  waiting: number;
  /** Applied in the last 7 days. */
  appliedThisWeek: number;
  rejected: number;
  /** Average time from asking to a decision, in minutes, over every decided request; null when none is decided. */
  averageReviewMinutes: number | null;
}

const MS_PER_MINUTE = 60_000;
const DAYS_IN_A_WEEK = 7;

/** The figures for the Update requests screen's tiles, over the record types the caller can read. */
export async function summariseUpdateRequests({ recordTypes }: ReadableTypes, now = new Date()): Promise<UpdateRequestSummary> {
  const weekAgo = new Date(now.getTime() - DAYS_IN_A_WEEK * 24 * 60 * MS_PER_MINUTE);
  const readable = { recordType: { $in: recordTypes } };
  const [waiting, appliedThisWeek, rejected, [review]] = await Promise.all([
    UpdateRequest.countDocuments({ ...readable, status: 'waiting' }),
    UpdateRequest.countDocuments({ ...readable, status: 'applied', decidedAt: { $gte: weekAgo } }),
    UpdateRequest.countDocuments({ ...readable, status: 'rejected' }),
    UpdateRequest.aggregate<{ averageMs: number }>([
      { $match: { ...readable, status: { $in: ['applied', 'rejected'] }, decidedAt: { $exists: true } } },
      { $group: { _id: null, averageMs: { $avg: { $subtract: ['$decidedAt', '$createdAt'] } } } },
    ]),
  ]);
  return { waiting, appliedThisWeek, rejected, averageReviewMinutes: review ? Math.round(review.averageMs / MS_PER_MINUTE) : null };
}

/** Applied requests, most recently applied first, for the Change history screen. */
export const findAppliedUpdateRequests = (limit: number) => UpdateRequest.find({ status: 'applied' }).sort({ decidedAt: -1 }).limit(limit).lean();

export const findUpdateRequestById = (requestId: string) => UpdateRequest.findById(requestId).lean();

export const findWaitingRequestFor = (recordId: string) => UpdateRequest.findOne({ recordId, status: 'waiting' }).lean();

/** The next number in the series. Taken outside the request's transaction, so a failed save leaves a gap rather than a repeat. */
export async function takeNextUpdateRequestNumber(): Promise<number> {
  const counter = await VoucherCounter.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { lastNumber: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  if (!counter) throw new Error('The update request counter returned nothing.');
  return counter.lastNumber;
}

export async function insertUpdateRequest(record: NewUpdateRequestRecord, createdBy: string, session: ClientSession): Promise<UpdateRequestDoc> {
  const [created] = await UpdateRequest.create([{ ...record, status: 'waiting', createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the update request returned nothing.');
  return created.toObject();
}

/** Saves a decision. `expectedVersion` refuses it if someone decided first, so two approvals can never both apply. */
export function changeUpdateRequest(requestId: string, update: UpdateQuery<UpdateRequestDoc>, context: { actorId: string; expectedVersion: number; session: ClientSession }) {
  return changeRecord(UpdateRequest, requestId, update, context, updateRequestNotFound);
}
