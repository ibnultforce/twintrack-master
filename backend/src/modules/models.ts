import { DemoNote } from './demo/models/note.js';
import { AccountsDocument } from './accounts/models/accountsDocument.js';
import { Invoice } from './accounts/models/invoice.js';
import { BankAccount, Category, CompanyBankDetails, Vendor } from './accounts/models/masterData.js';
import { Bill, Payment, Receipt } from './accounts/models/money.js';
import { PayrollRun } from './accounts/models/payroll.js';
import { hrModels } from './hr/models/index.js';
import { masterModels } from './master/models/index.js';
import { IncentiveLedgerEntry, IncentiveSetting, ProjectIncentive } from './projects/models/incentive.js';
import { PointsEntry } from './projects/models/pointsEntry.js';
import { Project } from './projects/models/project.js';
import { ProjectCredential } from './projects/models/projectCredential.js';
import { TaskAttachment, TaskAttachmentUsage } from './projects/models/taskAttachment.js';
import { Task } from './projects/models/task.js';
import { TaskComment } from './projects/models/taskComment.js';
import { TaskCounter } from './projects/models/taskCounter.js';

/** Every model in the app, for preparing and clearing collections. */
export const appModels = [DemoNote, ...masterModels, ...hrModels, Project, Task, TaskComment, TaskCounter, PointsEntry, ProjectCredential, TaskAttachment, TaskAttachmentUsage, IncentiveSetting, ProjectIncentive, IncentiveLedgerEntry, Category, Vendor, BankAccount, CompanyBankDetails, Bill, Payment, Receipt, Invoice, PayrollRun, AccountsDocument];
