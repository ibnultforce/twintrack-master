import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { ACCOUNTS_MODULE_KEY } from '../accountsModule.js';
import { assertMayDecide, mayDecide } from '../approvals/approvalRules.js';
import { findJournalVoucherById } from '../journalVoucher/journalVoucher.repository.js';
import { correctRecordedVoucher, linkedVoucherRefused } from '../journalVoucher/journalVoucher.service.js';
import { assertKeepsMoneyLine } from '../journalVoucher/moneyVoucher.js';
import { checkBalancedLines, type NewLedgerLine } from '../ledger/ledger.service.js';
import type { JournalVoucherDoc } from '../models/journalVoucher.js';
import { CORRECTABLE_RECORD_TYPES, type CorrectableRecordType, type UpdateRequestDoc, type UpdateRequestStatus, type VoucherContent } from '../models/updateRequest.js';
import {
  changeUpdateRequest,
  summariseUpdateRequests,
  findUpdateRequestById,
  findUpdateRequestsPage,
  findWaitingRequestFor,
  insertUpdateRequest,
  takeNextUpdateRequestNumber,
  updateRequestNotFound,
  type UpdateRequestListFilter,
} from './updateRequest.repository.js';

export const UPDATE_REQUEST_RESOURCE = 'updateRequest';
export const UPDATE_REQUEST_APPROVE_PERMISSION = 'updateRequest.approve';
const NUMBER_PREFIX = 'UR-';
const NUMBER_DIGITS = 4;

/** What a correctable record type needs before someone may ask to correct it. */
const READ_PERMISSION_OF: Record<CorrectableRecordType, string> = { journalVoucher: 'journalVoucher.read' };

/** A request shows the record's details before and after, so it is only for people who can read that record type. */
export const readableRecordTypes = (actor: Actor): CorrectableRecordType[] =>
  CORRECTABLE_RECORD_TYPES.filter((recordType) => actor.permissions[READ_PERMISSION_OF[recordType]]);

const cannotReadRecord = () => new ApiError(403, 'forbidden', "Your profile doesn't let you see this kind of record, so you can't see or decide requests about it.");

function assertMayReadRecordType(actor: Actor, recordType: CorrectableRecordType): void {
  if (!actor.permissions[READ_PERMISSION_OF[recordType]]) throw cannotReadRecord();
}

export interface NewUpdateRequest {
  recordType: CorrectableRecordType;
  recordId: string;
  reason: string;
  /** Only the parts to change; the rest stays as the record is. */
  changes: { voucherDate?: string; memo?: string; lines?: NewLedgerLine[] };
}

const historyRef = (requestId: string) => ({ module: ACCOUNTS_MODULE_KEY, object: UPDATE_REQUEST_RESOURCE, recordId: requestId });

const STATUS_LABELS: Record<UpdateRequestStatus, string> = { waiting: 'waiting for a decision', applied: 'already applied', rejected: 'rejected' };

const notWaiting = (request: UpdateRequestDoc, action: string) =>
  new ApiError(409, 'update_request_not_waiting', `This request is ${STATUS_LABELS[request.status]}, so it can't be ${action}.`);

const alreadyWaiting = (recordNumber: string) =>
  new ApiError(409, 'update_request_already_waiting', `${recordNumber} already has a request waiting for a decision. Decide on that one first.`);

async function requireUpdateRequest(requestId: string): Promise<UpdateRequestDoc> {
  const request = await findUpdateRequestById(requestId);
  if (!request) throw updateRequestNotFound();
  return request;
}

async function requireRecordedVoucher(voucherId: string): Promise<JournalVoucherDoc> {
  const voucher = await findJournalVoucherById(voucherId);
  if (!voucher) throw new ApiError(404, 'unknown_journal_voucher', 'No such journal voucher.');
  if (voucher.status !== 'recorded') {
    throw new ApiError(409, 'record_not_recorded', `${voucher.number} isn't recorded, so there is nothing to correct. Drafts are edited directly.`);
  }
  return voucher;
}

const contentOf = ({ voucherDate, memo, lines, total }: VoucherContent): VoucherContent => ({ voucherDate, memo, lines, total });

/** Whether the request would change nothing, compared field by field, lines in order. */
const isSameContent = (first: VoucherContent, second: VoucherContent) => JSON.stringify(contentOf(first)) === JSON.stringify(contentOf(second));

const auditFields = (actor: Actor, request: UpdateRequestDoc) => ({
  ...actorFields(actor),
  targetType: UPDATE_REQUEST_RESOURCE,
  targetId: request._id,
  targetName: `${request.number} ${request.recordNumber}`,
  module: ACCOUNTS_MODULE_KEY,
});

async function peopleNamed(requests: UpdateRequestDoc[]): Promise<Map<string, string>> {
  const ids = new Set(requests.flatMap((request) => [request.createdBy, request.decidedBy]).filter((id): id is string => Boolean(id)));
  return new Map((await findUsersByIds([...ids])).map((person) => [person._id, person.name]));
}

const personRef = (id: string | undefined, names: Map<string, string>) => (id ? { id, name: names.get(id) } : undefined);

function toUpdateRequestView(request: UpdateRequestDoc, names: Map<string, string>) {
  return {
    id: request._id,
    number: request.number,
    recordType: request.recordType,
    recordId: request.recordId,
    recordNumber: request.recordNumber,
    reason: request.reason,
    before: request.before,
    after: request.after,
    status: request.status,
    createdBy: personRef(request.createdBy, names),
    createdAt: request.createdAt,
    decidedBy: personRef(request.decidedBy, names),
    decidedAt: request.decidedAt,
    rejectionNote: request.rejectionNote,
    reversalEntryId: request.reversalEntryId,
    correctedEntryId: request.correctedEntryId,
    version: request.version,
  };
}

const toViewFor = async (request: UpdateRequestDoc) => toUpdateRequestView(request, await peopleNamed([request]));

/** Requests about record types the caller can read, newest first, with the figures for the screen's tiles. */
export async function listUpdateRequests(actor: Actor, query: PageRequest & UpdateRequestListFilter) {
  const recordTypes = readableRecordTypes(actor);
  const [{ requests, total }, summary] = await Promise.all([findUpdateRequestsPage({ ...query, recordTypes }), summariseUpdateRequests({ recordTypes })]);
  const names = await peopleNamed(requests);
  return { total, page: query.page, pageSize: query.pageSize, summary, requests: requests.map((request) => toUpdateRequestView(request, names)) };
}

/** One request, with whether the caller may approve or reject it, so a screen shows only buttons that will work. */
export async function getUpdateRequest(actor: Actor, requestId: string) {
  const request = await requireUpdateRequest(requestId);
  assertMayReadRecordType(actor, request.recordType);
  const canDecide = request.status === 'waiting' && (await mayDecide(actor, request, UPDATE_REQUEST_APPROVE_PERMISSION));
  return { ...(await toViewFor(request)), allowedActions: { approve: canDecide, reject: canDecide } };
}

/**
 * Asks for a recorded voucher to be corrected. The corrected lines are checked now, as postEntry will check them, so
 * a request that could never be applied is refused at once. Nothing in the books changes until someone approves it.
 */
export async function createUpdateRequest(actor: Actor, details: NewUpdateRequest) {
  assertMayReadRecordType(actor, details.recordType);
  const voucher = await requireRecordedVoucher(details.recordId);
  // A payment or receipt that settles an invoice or bill is reversed and made again instead, so the document stays right.
  if (voucher.linkedDocument) throw linkedVoucherRefused(voucher);
  if (await findWaitingRequestFor(voucher._id)) throw alreadyWaiting(voucher.number);

  const checked = details.changes.lines ? await checkBalancedLines(details.changes.lines) : undefined;
  if (checked) assertKeepsMoneyLine(voucher, checked.lines);
  const before = contentOf(voucher);
  const after: VoucherContent = {
    voucherDate: details.changes.voucherDate ?? before.voucherDate,
    memo: details.changes.memo ?? before.memo,
    lines: checked?.lines ?? before.lines,
    total: checked?.total ?? before.total,
  };
  if (isSameContent(before, after)) {
    throw new ApiError(422, 'no_change', 'The corrected voucher is the same as the recorded one. Change the date, memo or lines.');
  }

  const number = `${NUMBER_PREFIX}${String(await takeNextUpdateRequestNumber()).padStart(NUMBER_DIGITS, '0')}`;
  try {
    const request = await runInTransaction(async (session) => {
      const created = await insertUpdateRequest(
        { _id: `ur_${randomUUID()}`, number, recordType: details.recordType, recordId: voucher._id, recordNumber: voucher.number, reason: details.reason, before, after },
        actor.user._id,
        session,
      );
      await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
      await recordAudit({ action: 'updateRequest.created', ...auditFields(actor, created) }, session);
      return created;
    });
    return toViewFor(request);
  } catch (error) {
    // Someone else asked to correct the same voucher at the same moment; the unique index refused this one.
    if (isDuplicateKeyError(error)) throw alreadyWaiting(voucher.number);
    throw error;
  }
}

/**
 * Applies a request: reverses the voucher's ledger entry, records the corrected one and updates the voucher, all in
 * one transaction with the request's own change. The requester can't approve their own request, super admins included.
 */
export async function approveUpdateRequest(actor: Actor, requestId: string, version?: number) {
  const existing = await requireUpdateRequest(requestId);
  assertMayReadRecordType(actor, existing.recordType);
  if (existing.status !== 'waiting') throw notWaiting(existing, 'approved');
  await assertMayDecide(actor, existing, UPDATE_REQUEST_APPROVE_PERMISSION);

  const saved = await runInTransaction(async (session) => {
    const entries = await correctRecordedVoucher(actor, existing.recordId, existing.after, { requestNumber: existing.number, session });
    const result = await changeUpdateRequest(existing._id, {
      $set: { status: 'applied', decidedBy: actor.user._id, decidedAt: new Date(), ...entries },
    }, { actorId: actor.user._id, expectedVersion: version ?? existing.version, session });
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({ action: 'updateRequest.applied', ...auditFields(actor, result) }, session);
    return result;
  });
  return toViewFor(saved);
}

/** Turns a request down with a note saying why. Nothing in the books changes. */
export async function rejectUpdateRequest(actor: Actor, requestId: string, request: { note: string; version?: number }) {
  const existing = await requireUpdateRequest(requestId);
  assertMayReadRecordType(actor, existing.recordType);
  if (existing.status !== 'waiting') throw notWaiting(existing, 'rejected');
  await assertMayDecide(actor, existing, UPDATE_REQUEST_APPROVE_PERMISSION);

  const saved = await runInTransaction(async (session) => {
    const result = await changeUpdateRequest(existing._id, {
      $set: { status: 'rejected', decidedBy: actor.user._id, decidedAt: new Date(), rejectionNote: request.note },
    }, { actorId: actor.user._id, expectedVersion: request.version ?? existing.version, session });
    await writeRecordHistory(historyRef(existing._id), { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({ action: 'updateRequest.rejected', ...auditFields(actor, result) }, session);
    return result;
  });
  return toViewFor(saved);
}
