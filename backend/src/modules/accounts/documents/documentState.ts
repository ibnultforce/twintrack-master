import { ApiError } from '../../../lib/errors.js';
import type { SettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';

/*
 * What invoices and bills share: due dates, and how much of one is paid. Paid comes only from recorded vouchers
 * linked to the document, never from a stored figure, so it always agrees with the books.
 */

/** unpaid and part_paid while not yet due; overdue from the day after the due date until it is paid in full. */
export const PAYMENT_STATUSES = ['unpaid', 'part_paid', 'paid', 'overdue'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentState {
  /** Settled by recorded payments or receipts, in the document's currency. */
  paid: number;
  /** Still owed: the amount due less what is paid. */
  outstanding: number;
  /** Settled by payments or receipts still being drafted or waiting for approval. */
  pending: number;
  paymentStatus: PaymentStatus;
  /** Whole days past the due date; only when overdue. */
  daysOverdue?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const toUtcDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** A YYYY-MM-DD date plus some days, as YYYY-MM-DD. */
export const addDays = (date: string, days: number) => new Date(toUtcDay(date) + days * DAY_MS).toISOString().slice(0, 10);

/** How much of a document is paid, and whether it is late. `amountDue` is what its payments settle. */
export function paymentStateOf(amountDue: number, dueDate: string, settled: SettledAmounts | undefined, today = todayAsEntryDate()): PaymentState {
  const paid = settled?.recorded ?? 0;
  const outstanding = Math.max(0, amountDue - paid);
  const pending = (settled?.committed ?? 0) - paid;
  if (outstanding === 0) return { paid, outstanding, pending, paymentStatus: 'paid' };
  if (today > dueDate) return { paid, outstanding, pending, paymentStatus: 'overdue', daysOverdue: Math.round((toUtcDay(today) - toUtcDay(dueDate)) / DAY_MS) };
  return { paid, outstanding, pending, paymentStatus: paid > 0 ? 'part_paid' : 'unpaid' };
}

/**
 * Refuses a payment above what is still open: the amount due less everything already settled or on its way, so two
 * drafts can't pay the same bill twice.
 */
export function assertWithinOpenAmount(amount: number, amountDue: number, settled: SettledAmounts | undefined, documentNumber: string): void {
  const open = amountDue - (settled?.committed ?? 0);
  if (amount > open) {
    throw new ApiError(422, 'more_than_owed', `Only ${open} is still open on ${documentNumber}, counting payments waiting for approval.`, [
      { path: 'amount', message: `must be at most ${open}` },
    ]);
  }
}

/** The status error every document uses: "This bill is recorded, so it can't be edited." */
export const wrongDocumentStatus = (documentLabel: string, statusLabel: string, allowed: string, action: string) =>
  // The code joins words with underscores: "payroll run" gives payroll_run_not_draft.
  new ApiError(409, `${documentLabel.replace(/ /g, '_')}_not_${allowed}`, `This ${documentLabel} is ${statusLabel}, so it can't be ${action}.`);
