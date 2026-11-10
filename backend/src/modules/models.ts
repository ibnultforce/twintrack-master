import { Salary } from './hr/models/salary.js';
import { masterModels } from './master/models/index.js';
import { Project } from './tasks/models/project.js';
import { Task } from './tasks/models/task.js';
import { TaskComment } from './tasks/models/taskComment.js';
import { TaskCounter } from './tasks/models/taskCounter.js';

/** Every model in the app, for preparing and clearing collections. */
export const appModels = [...masterModels, Salary, Project, Task, TaskComment, TaskCounter];
