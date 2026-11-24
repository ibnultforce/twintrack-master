import { ApiError } from '../../../lib/errors.js';
import { findActiveClients, findClientById } from '../../master/clients/clients.repository.js';
import { toPaisa } from '../currency/exchangeRates.js';
import { addDays, paymentStateOf } from '../documents/documentState.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { Invoice, type InvoiceDoc } from '../models/invoice.js';
import { JournalVoucher } from '../models/journalVoucher.js';

/*
 * What each client has been billed, has paid and still owes, worked out from issued invoices and the recorded
 * receipts linked to them. Nothing here is stored: a client's balance is always the sum of their unpaid invoices.
 */

const AGEING_BUCKETS = [
  { key: 'notYetDue', label: 'Not yet due' },
  { key: 'days1To30', label: '1 to 30 days' },
  { key: 'days31To60', label: '31 to 60 days' },
  { key: 'over60', label: 'Over 60 days' },
] as const;
type AgeingKey = (typeof AGEING_BUCKETS)[number]['key'];

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_IN_FIRST_BUCKET = 30;
const DAYS_IN_SECOND_BUCKET = 60;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function ageingKey(daysOverdue: number | undefined): AgeingKey {
  if (!daysOverdue) return 'notYetDue';
  if (daysOverdue <= DAYS_IN_FIRST_BUCKET) return 'days1To30';
  if (daysOverdue <= DAYS_IN_SECOND_BUCKET) return 'days31To60';
  return 'over60';
}

interface Receipt {
  invoiceId: string;
  number: string;
  voucherId: string;
  date: string;
  /** In the invoice's currency. */
  amount: number;
}

/** Recorded receipts linked to these invoices, oldest first. */
async function findReceipts(invoiceIds: string[]): Promise<Receipt[]> {
  const vouchers = await JournalVoucher.find({ 'linkedDocument.type': 'invoice', 'linkedDocument.id': { $in: invoiceIds }, status: 'recorded' })
    .sort({ voucherDate: 1, number: 1 })
    .select('number voucherDate linkedDocument')
    .lean();
  return vouchers.map((voucher) => ({ invoiceId: voucher.linkedDocument?.id ?? '', number: voucher.number, voucherId: voucher._id, date: voucher.voucherDate, amount: voucher.linkedDocument?.amount ?? 0 }));
}

/** Converts an amount in an invoice's currency to taka at its issue rate, as the books recorded it. */
const inTaka = (invoice: InvoiceDoc, amount: number) => toPaisa(amount, invoice.exchangeRate ?? 100);

function summarise(invoices: InvoiceDoc[], receipts: Receipt[], today: string) {
  const receiptsByInvoice = new Map<string, Receipt[]>();
  for (const receipt of receipts) receiptsByInvoice.set(receipt.invoiceId, [...(receiptsByInvoice.get(receipt.invoiceId) ?? []), receipt]);
  const ageing: Record<AgeingKey, number> = { notYetDue: 0, days1To30: 0, days31To60: 0, over60: 0 };
  const paidDays: number[] = [];
  let billed = 0;
  let received = 0;
  let outstanding = 0;
  let overdueCount = 0;
  for (const invoice of invoices) {
    const own = receiptsByInvoice.get(invoice._id) ?? [];
    const paid = own.reduce((sum, receipt) => sum + receipt.amount, 0);
    const state = paymentStateOf(invoice.total, invoice.dueDate, { recorded: paid, committed: paid }, today);
    billed += inTaka(invoice, invoice.total);
    received += inTaka(invoice, paid);
    outstanding += inTaka(invoice, state.outstanding);
    if (state.paymentStatus === 'overdue') overdueCount += 1;
    if (state.outstanding > 0) ageing[ageingKey(state.daysOverdue)] += inTaka(invoice, state.outstanding);
    const lastReceipt = own.at(-1);
    if (state.paymentStatus === 'paid' && lastReceipt) paidDays.push(daysBetween(invoice.issueDate, lastReceipt.date));
  }
  const lastPayment = receipts.reduce<string | undefined>((latest, receipt) => (!latest || receipt.date > latest ? receipt.date : latest), undefined);
  return {
    invoiceCount: invoices.length,
    billed,
    received,
    outstanding,
    overdueCount,
    ageing,
    ...(lastPayment && { lastPayment }),
    ...(paidDays.length > 0 && { averageDaysToPay: Math.round(paidDays.reduce((sum, days) => sum + days, 0) / paidDays.length) }),
    // A client with an overdue invoice is one to watch.
    rating: overdueCount > 0 ? 'watch' : 'good',
  };
}

/** Every active client with issued invoices, what they were billed, paid and owe, in taka at the issue rates. */
export async function listClientAccounts(today = todayAsEntryDate()) {
  const [clients, invoices] = await Promise.all([findActiveClients(), Invoice.find({ status: 'issued' }).lean()]);
  const receipts = await findReceipts(invoices.map((invoice) => invoice._id));
  const byClient = new Map<string, InvoiceDoc[]>();
  for (const invoice of invoices) byClient.set(invoice.clientId, [...(byClient.get(invoice.clientId) ?? []), invoice]);
  const rows = clients
    .filter((client) => byClient.has(client._id))
    .map((client) => {
      const own = byClient.get(client._id) ?? [];
      const ownIds = new Set(own.map((invoice) => invoice._id));
      return { clientId: client._id, clientName: client.name, ...summarise(own, receipts.filter((receipt) => ownIds.has(receipt.invoiceId)), today) };
    });
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    ageingBuckets: AGEING_BUCKETS,
    totals: {
      billed: sum((row) => row.billed),
      received: sum((row) => row.received),
      outstanding: sum((row) => row.outstanding),
      ageing: Object.fromEntries(AGEING_BUCKETS.map(({ key }) => [key, sum((row) => row.ageing[key])])),
    },
    clients: rows,
  };
}

/**
 * One client's statement: their issued invoices and the receipts against them, by date, with the balance owed after
 * each, in taka at the invoices' issue rates. The closing balance equals the client's unpaid invoices.
 */
export async function getClientStatement(clientId: string, today = todayAsEntryDate()) {
  const client = await findClientById(clientId);
  if (!client) throw new ApiError(404, 'unknown_client', 'No such client.');
  const invoices = await Invoice.find({ clientId, status: 'issued' }).sort({ issueDate: 1, number: 1 }).lean();
  const receipts = await findReceipts(invoices.map((invoice) => invoice._id));
  const invoiceById = new Map(invoices.map((invoice) => [invoice._id, invoice]));

  const events = [
    ...invoices.map((invoice) => ({
      date: invoice.issueDate,
      kind: 'invoice' as const,
      id: invoice._id,
      number: invoice.number,
      currency: invoice.currency,
      amount: invoice.total,
      charge: inTaka(invoice, invoice.total),
      payment: 0,
      dueDate: invoice.dueDate,
    })),
    ...receipts.map((receipt) => {
      const invoice = invoiceById.get(receipt.invoiceId);
      return {
        date: receipt.date,
        kind: 'receipt' as const,
        id: receipt.voucherId,
        number: receipt.number,
        invoiceNumber: invoice?.number,
        currency: invoice?.currency ?? 'BDT',
        amount: receipt.amount,
        charge: 0,
        payment: invoice ? inTaka(invoice, receipt.amount) : 0,
      };
    }),
  ].sort((first, second) => first.date.localeCompare(second.date) || (first.kind === 'invoice' ? -1 : 1));

  let balance = 0;
  return {
    client: { id: client._id, name: client.name },
    ...summarise(invoices, receipts, today),
    lines: events.map((event) => {
      balance += event.charge - event.payment;
      return { ...event, balance };
    }),
    dueSoon: invoices.filter((invoice) => invoice.dueDate >= today && invoice.dueDate <= addDays(today, DAYS_IN_FIRST_BUCKET)).map((invoice) => invoice.number),
  };
}
