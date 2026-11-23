import type { Actor } from '../../master/access/caller.js';
import { findUsersByIds } from '../../master/users/users.repository.js';
import { findActiveStandInId } from '../settings/settings.service.js';

/*
 * One queue of everything waiting for a decision, across every Accounts record that needs approval. Each record type
 * adds itself to APPROVAL_SOURCES; the queue only asks it for waiting records. Who may decide follows the same rule
 * as assertMayDecide: not the maker, and the approve permission or today's stand-in.
 */

/** The most items one list returns per record type. The count says how many there are in all. */
const MAX_ITEMS_PER_SOURCE = 200;

/** One record waiting for a decision, the same shape whatever its type. */
export interface WaitingRecord {
  id: string;
  /** Its number, such as JV-0004. */
  number: string;
  /** What it is for. */
  title: string;
  /** Whole paisa. */
  amount: number;
  /** Its accounting date, YYYY-MM-DD. */
  date: string;
  createdBy?: string;
  submittedAt?: Date;
}

export interface ApprovalSource {
  /** The manifest resource, such as journalVoucher, which screens use to link to the record. */
  type: string;
  /** Needed to see the records at all. */
  readPermission: string;
  /** Other permissions needed to see them, such as reading the vouchers an update request changes. */
  alsoNeeds?: string[];
  /** Lets someone other than the maker decide. The stand-in may decide without it. */
  approvePermission: string;
  findWaiting(creator: { notMadeBy: string } | { madeBy: string }, limit: number): Promise<{ records: WaitingRecord[]; total: number }>;
}

interface ApprovalItem extends Omit<WaitingRecord, 'createdBy'> {
  type: string;
  createdBy?: { id: string; name?: string };
}

interface ApprovalList {
  total: number;
  items: ApprovalItem[];
}

const oldestFirst = (first: ApprovalItem, second: ApprovalItem) => (first.submittedAt?.getTime() ?? 0) - (second.submittedAt?.getTime() ?? 0);

async function collect(
  sources: ApprovalSource[],
  creator: { notMadeBy: string } | { madeBy: string },
): Promise<{ total: number; items: (WaitingRecord & { type: string })[] }> {
  const found = await Promise.all(sources.map(async (source) => {
    const { records, total } = await source.findWaiting(creator, MAX_ITEMS_PER_SOURCE);
    return { total, items: records.map((record) => ({ ...record, type: source.type })) };
  }));
  return { total: found.reduce((sum, part) => sum + part.total, 0), items: found.flatMap((part) => part.items) };
}

/**
 * What the caller may decide on now (`waitingForYou`), and what they made that waits for someone else
 * (`yoursWaiting`), oldest submission first. Record types the caller can't read are left out of both.
 */
export async function listApprovals(actor: Actor, sources: ApprovalSource[]): Promise<{ waitingForYou: ApprovalList; yoursWaiting: ApprovalList }> {
  const readable = sources.filter((source) => [source.readPermission, ...(source.alsoNeeds ?? [])].every((permission) => actor.permissions[permission]));
  const isStandIn = (await findActiveStandInId()) === actor.user._id;
  const decidable = readable.filter((source) => isStandIn || actor.permissions[source.approvePermission]);

  const [forYou, yours] = await Promise.all([
    collect(decidable, { notMadeBy: actor.user._id }),
    collect(readable, { madeBy: actor.user._id }),
  ]);

  const makerIds = [...new Set([...forYou.items, ...yours.items].flatMap((item) => (item.createdBy ? [item.createdBy] : [])))];
  const names = new Map((await findUsersByIds(makerIds)).map((person) => [person._id, person.name]));
  const toList = ({ total, items }: typeof forYou): ApprovalList => ({
    total,
    items: items.map(({ createdBy, ...item }) => ({ ...item, ...(createdBy && { createdBy: { id: createdBy, name: names.get(createdBy) } }) })).sort(oldestFirst),
  });
  return { waitingForYou: toList(forYou), yoursWaiting: toList(yours) };
}
