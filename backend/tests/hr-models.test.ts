import { describe, expect, it } from 'vitest';
import { Attendance } from '../src/modules/hr/models/attendance.js';
import { EmployeeDocument } from '../src/modules/hr/models/employeeDocument.js';
import { EmployeeProfile } from '../src/modules/hr/models/employeeProfile.js';
import { HolidayPayment } from '../src/modules/hr/models/holidayPayment.js';
import { LeaveBalance, LeaveRequest } from '../src/modules/hr/models/leave.js';
import { PayrollProfile } from '../src/modules/hr/models/payrollProfile.js';
import { Promotion } from '../src/modules/hr/models/promotion.js';
import { Review } from '../src/modules/hr/models/review.js';
import { WorkFromHomeRequest } from '../src/modules/hr/models/workFromHomeRequest.js';
import { WITH_DELETED } from '../src/lib/records/recordFields.js';
import { useTestDatabase } from './helpers/database.js';

useTestDatabase();

const day = new Date('2026-11-01');

/** Lets a test pass a value the types already forbid, to show the database refuses it too. */
function untyped(fields: Record<string, unknown>): never {
  return fields as never;
}

describe('HR models', () => {
  it('save a minimal record of each kind', async () => {
    await EmployeeProfile.create({ _id: 'ep_1', employeeId: 'u_1' });
    await PayrollProfile.create({ _id: 'pp_1', employeeId: 'u_1', currency: 'BDT' });
    await Promotion.create({ _id: 'pr_1', employeeId: 'u_1', effectiveOn: day });
    await EmployeeDocument.create({ _id: 'ed_1', employeeId: 'u_1', type: 'cv', fileName: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 10, storageKey: 'hr/u_1/ed_1', uploadedBy: 'u_2' });
    await LeaveBalance.create({ _id: 'lb_1', employeeId: 'u_1', leaveType: 'casual', year: 2026, entitlementDays: 10 });
    await LeaveRequest.create({ _id: 'lr_1', employeeId: 'u_1', leaveDate: day, reason: 'Family', leadApprovals: [{ _id: 'la_1', leadId: 'u_3', projectIds: ['p_1'] }] });
    await WorkFromHomeRequest.create({ _id: 'wfh_1', employeeId: 'u_1', workDate: day, reason: 'Repairs' });
    await HolidayPayment.create({ _id: 'hp_1', employeeId: 'u_1', holidayDate: day, title: 'Victory Day', amount: 1500, currency: 'BDT' });
    await Attendance.create({ _id: 'at_1', employeeId: 'u_1', workDate: day, status: 'present', source: 'device', punches: [{ _id: 'pu_1', direction: 'in', occurredAt: day }] });
    await Review.create({ _id: 'rv_1', employeeId: 'u_1', reviewDate: day });

    const profile = await EmployeeProfile.findById('ep_1').lean();
    expect(profile).toMatchObject({ version: 0, weeklyOffDays: [], nominees: [], clearanceHrDone: false });
    const request = await LeaveRequest.findById('lr_1').lean();
    expect(request).toMatchObject({ status: 'pending', leaveType: 'casual', unpaid: false });
    expect(request?.leadApprovals[0]).toMatchObject({ _id: 'la_1', status: 'pending' });
  });

  it('refuse values outside their lists', async () => {
    await expect(EmployeeProfile.create(untyped({ _id: 'ep_1', employeeId: 'u_1', gender: 'MALE' }))).rejects.toThrow(/gender/);
    await expect(Attendance.create(untyped({ _id: 'at_1', employeeId: 'u_1', workDate: day, status: 'present', source: 'api' }))).rejects.toThrow(/source/);
    await expect(EmployeeDocument.create(untyped({ _id: 'ed_1', employeeId: 'u_1', type: 'selfie', fileName: 'a', mimeType: 'b', sizeBytes: 1, storageKey: 'k', uploadedBy: 'u_2' }))).rejects.toThrow(/type/);
  });

  it('keep one HR file per person', async () => {
    await EmployeeProfile.create({ _id: 'ep_1', employeeId: 'u_1' });
    await expect(EmployeeProfile.create({ _id: 'ep_2', employeeId: 'u_1' })).rejects.toThrow(/duplicate key/);
  });

  it('keep one casual balance per year and one awarded balance per person', async () => {
    await LeaveBalance.create({ _id: 'lb_1', employeeId: 'u_1', leaveType: 'casual', year: 2026 });
    await LeaveBalance.create({ _id: 'lb_2', employeeId: 'u_1', leaveType: 'casual', year: 2027 });
    await expect(LeaveBalance.create({ _id: 'lb_3', employeeId: 'u_1', leaveType: 'casual', year: 2026 })).rejects.toThrow(/duplicate key/);

    await LeaveBalance.create({ _id: 'lb_4', employeeId: 'u_1', leaveType: 'awarded' });
    await expect(LeaveBalance.create({ _id: 'lb_5', employeeId: 'u_1', leaveType: 'awarded' })).rejects.toThrow(/duplicate key/);
  });

  it('keep one attendance record per person per day', async () => {
    await Attendance.create({ _id: 'at_1', employeeId: 'u_1', workDate: day, status: 'present', source: 'manual' });
    await expect(Attendance.create({ _id: 'at_2', employeeId: 'u_1', workDate: day, status: 'late', source: 'manual' })).rejects.toThrow(/duplicate key/);
  });

  it('hide records in the recycle bin unless asked', async () => {
    await Review.create({ _id: 'rv_1', employeeId: 'u_1', reviewDate: day, deletedAt: day });
    expect(await Review.find({})).toHaveLength(0);
    expect(await Review.find({}, null, WITH_DELETED)).toHaveLength(1);
  });
});
