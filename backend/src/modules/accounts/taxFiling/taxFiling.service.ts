import { ApiError } from '../../../lib/errors.js';
import type { Actor } from '../../master/access/caller.js';
import { addDays, assertWithinOpenAmount, paymentStateOf } from '../documents/documentState.js';
import { addMonths } from '../fixedAsset/depreciation.js';
import { financialYearLabel, financialYearOf, monthsOfFinancialYear } from '../financialYear.js';
import { findLinkedReferences, sumSettledAmounts } from '../journalVoucher/journalVoucher.repository.js';
import { createLinkedVoucher } from '../journalVoucher/journalVoucher.service.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';
import { Bill } from '../models/bill.js';
import { monthLabel } from '../payroll/payroll.service.js';
import { POSTING_ACCOUNTS } from '../postingAccounts.js';
import { findOrCreateSettings } from '../settings/settings.repository.js';

/*
 * Tax worked out from recorded bills each month, never stored. TDS withheld from vendors is owed to the tax authority
 * (2300) and paid with a challan: a payment voucher linked to that month, so whether it is paid agrees with the books.
 * VAT paid on purchases is claimed back (1700), so it is shown for the return, not paid. Rates come from Settings and
 * each vendor; there is no challan format (decision 6).
 */

/** The day of the next month each is due: TDS by the 7th, the VAT return by the 15th. */
const TDS_DUE_DAY = '07';
const VAT_DUE_DAY = '15';

export const TAX_TYPES = ['vendor_tds', 'vat_purchases'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

const filingDocumentId = (month: string) => `tax_vendor_tds_${month}`;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const monthEnd = (month: string) => addDays(`${addMonths(month, 1)}-01`, -1);

/** Each month's recorded bills: their amount before tax, VAT and TDS, by the month of the bill date. */
async function billTaxByMonth(firstMonth: string, lastMonth: string) {
  const rows = await Bill.aggregate<{ _id: string; vatBase: number; vat: number; tdsBase: number; tds: number; bills: number }>([
    { $match: { status: 'recorded', billDate: { $gte: `${firstMonth}-01`, $lte: monthEnd(lastMonth) } } },
    {
      $group: {
        _id: { $substrCP: ['$billDate', 0, 7] },
        vatBase: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$vat', 0] }, 0] }, '$amount', 0] } },
        vat: { $sum: { $ifNull: ['$vat', 0] } },
        tdsBase: { $sum: { $cond: [{ $gt: ['$tds', 0] }, '$amount', 0] } },
        tds: { $sum: '$tds' },
        bills: { $sum: 1 },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id, row]));
}

/**
 * A financial year's tax, month by month up to this month: TDS withheld from vendors, with whether it is paid, and
 * VAT paid on purchases to claim. The Settings tax rates are listed beside it.
 */
export async function getTaxFilings(year = financialYearOf(todayAsEntryDate())) {
  const thisMonth = todayAsEntryDate().slice(0, 7);
  const months = monthsOfFinancialYear(year).filter((month) => month <= thisMonth);
  const [byMonth, settled, challans, settings] = await Promise.all([
    months.length > 0 ? billTaxByMonth(months[0] ?? thisMonth, months[months.length - 1] ?? thisMonth) : Promise.resolve(new Map()),
    sumSettledAmounts(months.map(filingDocumentId)),
    findLinkedReferences(months.map(filingDocumentId)),
    findOrCreateSettings(),
  ]);
  const filings = months.flatMap((month) => {
    const totals = byMonth.get(month);
    const nextMonth = addMonths(month, 1);
    const tds = totals?.tds ?? 0;
    return [
      {
        type: 'vendor_tds' as const,
        month,
        monthLabel: monthLabel(month),
        base: totals?.tdsBase ?? 0,
        amount: tds,
        dueDate: `${nextMonth}-${TDS_DUE_DAY}`,
        ...paymentStateOf(tds, `${nextMonth}-${TDS_DUE_DAY}`, settled.get(filingDocumentId(month))),
        // The challan numbers of its payments that aren't reversed, including ones still waiting for approval.
        challans: challans.get(filingDocumentId(month)) ?? [],
      },
      {
        type: 'vat_purchases' as const,
        month,
        monthLabel: monthLabel(month),
        base: totals?.vatBase ?? 0,
        amount: totals?.vat ?? 0,
        dueDate: `${nextMonth}-${VAT_DUE_DAY}`,
      },
    ];
  });
  const ofType = (type: TaxType) => filings.filter((filing) => filing.type === type);
  return {
    year,
    yearLabel: financialYearLabel(year),
    taxRates: settings.taxRates,
    filings: filings.reverse(),
    totals: {
      tdsWithheld: sum(ofType('vendor_tds').map((filing) => filing.amount)),
      tdsToPay: sum(ofType('vendor_tds').map((filing) => ('outstanding' in filing ? filing.outstanding : 0))),
      vatToClaim: sum(ofType('vat_purchases').map((filing) => filing.amount)),
    },
  };
}

/**
 * Pays a month's TDS to the tax authority: a draft payment voucher clearing what is owed (2300), with the challan
 * number as its reference. Someone other than its maker approves it, like any voucher.
 */
export async function payVendorTds(actor: Actor, month: string, request: { paymentDate: string; moneyAccountId: string; challanNumber: string }) {
  const totals = (await billTaxByMonth(month, month)).get(month);
  const owed = totals?.tds ?? 0;
  const label = `TDS ${monthLabel(month)}`;
  if (owed === 0) throw new ApiError(409, 'nothing_owed', `${monthLabel(month)} has no TDS to pay.`);
  const settled = (await sumSettledAmounts([filingDocumentId(month)])).get(filingDocumentId(month));
  const amount = owed - (settled?.committed ?? 0);
  if (amount <= 0) throw new ApiError(409, 'nothing_owed', `${label} is paid, or its payment is waiting for approval.`);
  assertWithinOpenAmount(amount, owed, settled, label);
  return createLinkedVoucher(actor, 'payment', {
    voucherDate: request.paymentDate,
    memo: `TDS on vendor bills, ${monthLabel(month)}`,
    party: 'Tax authority',
    reference: request.challanNumber,
    moneyAccountId: request.moneyAccountId,
    lines: [
      { accountId: POSTING_ACCOUNTS.taxPayable, debit: amount, memo: label },
      { accountId: request.moneyAccountId, credit: amount, memo: `Challan ${request.challanNumber}` },
    ],
    linkedDocument: { type: 'taxFiling', id: filingDocumentId(month), number: label, amount, amountDue: owed },
  });
}
