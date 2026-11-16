import { Attendance } from './attendance.js';
import { EmployeeDocument } from './employeeDocument.js';
import { EmployeeProfile } from './employeeProfile.js';
import { HolidayPayment } from './holidayPayment.js';
import { LeaveBalance, LeaveRequest } from './leave.js';
import { PayrollProfile } from './payrollProfile.js';
import { Promotion } from './promotion.js';
import { Review } from './review.js';
import { Salary } from './salary.js';
import { WorkFromHomeRequest } from './workFromHomeRequest.js';

/** Every HR model, for preparing and clearing collections. */
export const hrModels = [
  Salary,
  EmployeeProfile,
  PayrollProfile,
  Promotion,
  EmployeeDocument,
  LeaveBalance,
  LeaveRequest,
  WorkFromHomeRequest,
  HolidayPayment,
  Attendance,
  Review,
];
