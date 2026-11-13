import { PayrollRun } from '../models/payroll.js';
import { Payment, Receipt } from '../models/money.js';

/**
 * Money in and out of bank accounts, worked out from posted records. Receipts add what reached the bank, after its fee.
 * Payments and paid salaries take money out. A reversal moves its original's money back, on the reversal's own date.
 */

export interface BankMovement {
  date: Date;
  kind: 'receipt' | 'receipt_reversal' | 'payment' | 'payment_reversal' | 'salary';
  recordId: string;
  /** Positive for money in, negative for money out. */
  amount: number;
  reference?: string;
  payrollRunId?: string;
}

interface Period {
  /** Movements on or after this moment. */
  from?: Date;
  /** Movements before this moment. */
  before?: Date;
}

const dateRange = (field: string, { from, before }: Period) =>
  from || before ? { [field]: { ...(from && { $gte: from }), ...(before && { $lt: before }) } } : {};

/** Every movement through these accounts in the period, oldest first. */
export async function findBankMovements(bankAccountIds: string[], period: Period = {}): Promise<(BankMovement & { bankAccountId: string })[]> {
  const [receipts, payments, runs] = await Promise.all([
    Receipt.find({ bankAccountId: { $in: bankAccountIds }, ...dateRange('receivedDate', period) }).select('bankAccountId amount bankFee receivedDate reference reversesId').lean(),
    Payment.find({ bankAccountId: { $in: bankAccountIds }, ...dateRange('paymentDate', period) }).select('bankAccountId amount paymentDate reference reversesId').lean(),
    PayrollRun.find({ items: { $elemMatch: { bankAccountId: { $in: bankAccountIds }, settlementStatus: 'paid', ...dateRange('settledAt', period) } } }).select('items').lean(),
  ]);

  const movements = [
    ...receipts.map((receipt) => {
      const net = receipt.amount - receipt.bankFee;
      return {
        bankAccountId: receipt.bankAccountId,
        date: receipt.receivedDate,
        kind: receipt.reversesId ? ('receipt_reversal' as const) : ('receipt' as const),
        recordId: receipt._id,
        amount: receipt.reversesId ? -net : net,
        reference: receipt.reference,
      };
    }),
    ...payments.map((payment) => ({
      bankAccountId: payment.bankAccountId,
      date: payment.paymentDate,
      kind: payment.reversesId ? ('payment_reversal' as const) : ('payment' as const),
      recordId: payment._id,
      amount: payment.reversesId ? payment.amount : -payment.amount,
      reference: payment.reference,
    })),
    ...runs.flatMap((run) =>
      run.items
        .filter((item) => item.bankAccountId && bankAccountIds.includes(item.bankAccountId) && item.settlementStatus === 'paid' && item.settledAt)
        .filter((item) => (!period.from || item.settledAt! >= period.from) && (!period.before || item.settledAt! < period.before))
        .map((item) => ({
          bankAccountId: item.bankAccountId!,
          date: item.settledAt!,
          kind: 'salary' as const,
          recordId: item._id,
          payrollRunId: run._id,
          amount: -item.netAmount,
          reference: item.reference,
        })),
    ),
  ];
  return movements.sort((first, second) => first.date.getTime() - second.date.getTime() || first.recordId.localeCompare(second.recordId));
}

/** The sum of every movement through each account in the period, by account. */
export async function sumBankMovements(bankAccountIds: string[], period: Period = {}): Promise<Map<string, number>> {
  const sums = new Map<string, number>();
  for (const movement of await findBankMovements(bankAccountIds, period)) {
    sums.set(movement.bankAccountId, (sums.get(movement.bankAccountId) ?? 0) + movement.amount);
  }
  return sums;
}
