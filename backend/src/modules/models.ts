import { AccountsEmployee } from './accounts/models/accountsEmployee.js';
import { LedgerAccount } from './accounts/models/ledgerAccount.js';
import { AccountsSettings } from './accounts/models/accountsSettings.js';
import { JournalVoucher, VoucherCounter } from './accounts/models/journalVoucher.js';
import { UpdateRequest } from './accounts/models/updateRequest.js';
import { LedgerEntry } from './accounts/models/ledgerEntry.js';
import { Bill } from './accounts/models/bill.js';
import { ClientAccount } from './accounts/models/clientAccount.js';
import { Invoice } from './accounts/models/invoice.js';
import { Vendor } from './accounts/models/vendor.js';
import { DemoNote } from './demo/models/note.js';
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
export const appModels = [DemoNote, ...masterModels, ...hrModels, Project, Task, TaskComment, TaskCounter, PointsEntry, ProjectCredential, TaskAttachment, TaskAttachmentUsage, IncentiveSetting, ProjectIncentive, IncentiveLedgerEntry, LedgerAccount, LedgerEntry, AccountsSettings, JournalVoucher, VoucherCounter, UpdateRequest, AccountsEmployee, ClientAccount, Invoice, Vendor, Bill];
