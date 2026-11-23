import type { Actor } from '../../master/access/caller.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { findReversedJournalVouchers } from '../journalVoucher/journalVoucher.repository.js';
import type { VoucherContent } from '../models/updateRequest.js';
import { findAppliedUpdateRequests } from '../updateRequest/updateRequest.repository.js';

/*
 * The Change history screen: every change made to a recorded voucher after it reached the books. A correction comes
 * from an applied update request; a reversal cancels a voucher outright. Drafts aren't here: until a voucher is
 * recorded, its own history holds its edits.
 */

/** The most entries of each kind the screen shows, newest first. */
const MAX_ENTRIES_PER_KIND = 200;

type ChangeKind = 'correction' | 'reversal';

/** One field that changed, in plain values the screen can show: a date, a memo or a total in paisa. */
interface FieldChange {
  field: 'voucherDate' | 'memo' | 'total' | 'lines';
  from?: string | number;
  to?: string | number;
}

interface ChangeEntry {
  kind: ChangeKind;
  /** When it reached the books. */
  at?: Date;
  recordType: 'journalVoucher';
  recordId: string;
  recordNumber: string;
  /** The update request behind a correction. */
  request?: { id: string; number: string };
  reason?: string;
  changes: FieldChange[];
  askedBy?: { id: string; name?: string };
  approvedBy?: { id: string; name?: string };
}

/** What a correction changed, field by field. Lines are named only as changed: their detail is on the request. */
function changesBetween(before: VoucherContent, after: VoucherContent): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.voucherDate !== after.voucherDate) changes.push({ field: 'voucherDate', from: before.voucherDate, to: after.voucherDate });
  if (before.memo !== after.memo) changes.push({ field: 'memo', from: before.memo, to: after.memo });
  if (before.total !== after.total) changes.push({ field: 'total', from: before.total, to: after.total });
  else if (JSON.stringify(before.lines) !== JSON.stringify(after.lines)) changes.push({ field: 'lines' });
  return changes;
}

/**
 * Corrections and reversals, newest first. Reversals need journalVoucher.read; corrections show what a voucher
 * said before and after, so they need updateRequest.read as well. A kind the caller can't read is left out.
 */
export async function listChangeHistory(actor: Actor) {
  const canSeeReversals = Boolean(actor.permissions['journalVoucher.read']);
  const canSeeCorrections = canSeeReversals && Boolean(actor.permissions['updateRequest.read']);
  const [corrections, reversals] = await Promise.all([
    canSeeCorrections ? findAppliedUpdateRequests(MAX_ENTRIES_PER_KIND) : [],
    canSeeReversals ? findReversedJournalVouchers(MAX_ENTRIES_PER_KIND) : [],
  ]);

  const personIds = [
    ...corrections.flatMap((request) => [request.createdBy, request.decidedBy]),
    ...reversals.map((voucher) => voucher.reversedBy),
  ].filter((id): id is string => Boolean(id));
  const names = new Map((await findUsersByIds([...new Set(personIds)])).map((person) => [person._id, person.name]));
  const personRef = (id?: string) => (id ? { id, name: names.get(id) } : undefined);

  const entries: ChangeEntry[] = [
    ...corrections.map((request): ChangeEntry => ({
      kind: 'correction',
      at: request.decidedAt,
      recordType: request.recordType,
      recordId: request.recordId,
      recordNumber: request.recordNumber,
      request: { id: request._id, number: request.number },
      reason: request.reason,
      changes: changesBetween(request.before, request.after),
      askedBy: personRef(request.createdBy),
      approvedBy: personRef(request.decidedBy),
    })),
    ...reversals.map((voucher): ChangeEntry => ({
      kind: 'reversal',
      at: voucher.reversedAt,
      recordType: 'journalVoucher',
      recordId: voucher._id,
      recordNumber: voucher.number,
      changes: [{ field: 'total', from: voucher.total, to: 0 }],
      approvedBy: personRef(voucher.reversedBy),
    })),
  ];
  entries.sort((first, second) => (second.at?.getTime() ?? 0) - (first.at?.getTime() ?? 0));
  return { entries };
}
