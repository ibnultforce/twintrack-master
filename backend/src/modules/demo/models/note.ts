import { Schema, model } from 'mongoose';

/** A short note, the one record of the Demo module, for trying module APIs and their scopes. */
export interface NoteDoc {
  _id: string;
  title: string;
  body: string;
  /** Who wrote it. The note.* scope reaches notes by their writer. */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const noteSchema = new Schema<NoteDoc>(
  {
    _id: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    createdBy: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export const DemoNote = model<NoteDoc>('DemoNote', noteSchema, 'demo_notes');
