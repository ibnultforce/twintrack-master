import type { ApprovalSource } from '../approvals/approvalQueue.service.js';
import { findWaitingUpdateRequests } from './updateRequest.repository.js';
import { UPDATE_REQUEST_APPROVE_PERMISSION } from './updateRequest.service.js';

/** Update requests waiting for a decision, for the Approvals queue. Amount and date are the corrected voucher's. */
export const updateRequestApprovals: ApprovalSource = {
  type: 'updateRequest',
  readPermission: 'updateRequest.read',
  // Requests show voucher details, so the voucher read permission is needed too.
  alsoNeeds: ['journalVoucher.read'],
  approvePermission: UPDATE_REQUEST_APPROVE_PERMISSION,
  async findWaiting(creator, limit) {
    const { requests, total } = await findWaitingUpdateRequests(creator, limit);
    return {
      total,
      records: requests.map((request) => ({
        id: request._id,
        number: request.number,
        title: `${request.recordNumber}: ${request.reason}`,
        amount: request.after.total,
        date: request.after.voucherDate,
        createdBy: request.createdBy,
        submittedAt: request.createdAt,
      })),
    };
  },
};
