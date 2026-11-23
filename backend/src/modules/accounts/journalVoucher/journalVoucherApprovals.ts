import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { findSubmittedJournalVouchers } from './journalVoucher.repository.js';

/** Journal vouchers waiting for approval, for the Approvals queue. */
export const journalVoucherApprovals: ApprovalSource = {
  type: 'journalVoucher',
  readPermission: 'journalVoucher.read',
  approvePermission: 'journalVoucher.approve',
  async findWaiting(creator, limit) {
    const { vouchers, total } = await findSubmittedJournalVouchers(creator, limit);
    return {
      total,
      records: vouchers.map((voucher) => ({
        id: voucher._id,
        number: voucher.number,
        title: voucher.memo,
        amount: voucher.total,
        date: voucher.voucherDate,
        createdBy: voucher.createdBy,
        submittedAt: voucher.submittedAt,
      })),
    };
  },
};
