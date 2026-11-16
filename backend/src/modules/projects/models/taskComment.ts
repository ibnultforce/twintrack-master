import { Schema, model } from 'mongoose';

/** One message on a task. Comments are never edited or deleted, and every revert writes one with its reason. */
export interface TaskCommentDoc {
  _id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

const taskCommentSchema = new Schema<TaskCommentDoc>(
  {
    _id: { type: String, required: true },
    taskId: { type: String, required: true, index: true },
    authorId: { type: String, required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const TaskComment = model<TaskCommentDoc>('TaskComment', taskCommentSchema);
