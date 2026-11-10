import { Schema, model } from 'mongoose';

/** The last task number handed out. Numbers are taken outside the task's transaction, so one is never handed out twice. */
interface TaskCounterDoc {
  _id: string;
  lastNumber: number;
}

const taskCounterSchema = new Schema<TaskCounterDoc>({
  _id: { type: String, required: true },
  lastNumber: { type: Number, required: true, default: 0 },
});

export const TaskCounter = model<TaskCounterDoc>('TaskCounter', taskCounterSchema);
