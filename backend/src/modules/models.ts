import { Salary } from './hr/models/salary.js';
import { masterModels } from './master/models/index.js';
import { IncentiveLedgerEntry, IncentiveSetting, ProjectIncentive } from './tasks/models/incentive.js';
import { PointsEntry } from './tasks/models/pointsEntry.js';
import { Project } from './tasks/models/project.js';
import { ProjectCredential } from './tasks/models/projectCredential.js';
import { TaskAttachment, TaskAttachmentUsage } from './tasks/models/taskAttachment.js';
import { Task } from './tasks/models/task.js';
import { TaskComment } from './tasks/models/taskComment.js';
import { TaskCounter } from './tasks/models/taskCounter.js';

/** Every model in the app, for preparing and clearing collections. */
export const appModels = [...masterModels, Salary, Project, Task, TaskComment, TaskCounter, PointsEntry, ProjectCredential, TaskAttachment, TaskAttachmentUsage, IncentiveSetting, ProjectIncentive, IncentiveLedgerEntry];
