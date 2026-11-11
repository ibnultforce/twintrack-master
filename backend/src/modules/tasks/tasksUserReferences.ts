import { WITH_DELETED } from '../../lib/records/recordFields.js';
import type { UserReferenceCheck } from '../../lib/userReferences.js';
import { Project } from './models/project.js';
import { Task } from './models/task.js';
import { TaskComment } from './models/taskComment.js';

/** Tasks records that keep a person from being deleted. Records in the recycle bin count, because they can be restored. */
export const tasksUserReferenceChecks: UserReferenceCheck[] = [
  {
    description: 'projects',
    isReferenced: async (userId) => Boolean(await Project.exists({ $or: [{ leadId: userId }, { memberIds: userId }] }).setOptions(WITH_DELETED)),
  },
  {
    description: 'tasks',
    isReferenced: async (userId) =>
      Boolean(await Task.exists({ $or: [{ assignedDevId: userId }, { tlId: userId }, { qaId: userId }] }).setOptions(WITH_DELETED)),
  },
  {
    description: 'task comments',
    isReferenced: async (userId) => Boolean(await TaskComment.exists({ authorId: userId })),
  },
];
