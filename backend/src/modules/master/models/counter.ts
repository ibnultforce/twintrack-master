import { Schema, model } from 'mongoose';

/** The last number handed out in one numbered series, such as employee numbers. One document per series. */
export interface CounterDoc {
  _id: string;
  lastNumber: number;
}

const counterSchema = new Schema<CounterDoc>({
  _id: { type: String, required: true },
  lastNumber: { type: Number, required: true, default: 0 },
});

export const Counter = model<CounterDoc>('Counter', counterSchema);
