import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import type { Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { DemoNote, type NoteDoc } from '../models/note.js';

export interface NoteChanges {
  title?: string;
  body?: string;
}

const noteNotFound = () => new ApiError(404, 'note_not_found', 'No such note, or it is beyond your reach.');

/** The notes a scope reaches: the caller's own, their reporting line's, or everyone's. */
async function scopeFilter(actor: Actor, scope: Scope) {
  const writers = await peopleInScope(actor.user._id, scope);
  return writers === null ? {} : { createdBy: { $in: writers } };
}

function toNote({ _id, ...fields }: NoteDoc) {
  return { id: _id, ...fields };
}

export async function listNotes(actor: Actor, scope: Scope, page: PageRequest) {
  const filter = await scopeFilter(actor, scope);
  const [notes, total] = await Promise.all([
    DemoNote.find(filter).sort({ createdAt: -1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    DemoNote.countDocuments(filter),
  ]);
  return { notes: notes.map(toNote), total, page: page.page, pageSize: page.pageSize };
}

export async function getNote(actor: Actor, scope: Scope, noteId: string) {
  const note = await DemoNote.findOne({ _id: noteId, ...(await scopeFilter(actor, scope)) }).lean();
  if (!note) throw noteNotFound();
  return toNote(note);
}

export async function createNote(actor: Actor, details: { title: string; body?: string }) {
  const note = await DemoNote.create({ _id: randomUUID(), title: details.title, body: details.body ?? '', createdBy: actor.user._id });
  return toNote(note.toObject());
}

export async function updateNote(actor: Actor, scope: Scope, noteId: string, changes: NoteChanges) {
  const note = await DemoNote.findOneAndUpdate({ _id: noteId, ...(await scopeFilter(actor, scope)) }, { $set: changes }, { new: true }).lean();
  if (!note) throw noteNotFound();
  return toNote(note);
}

export async function deleteNote(actor: Actor, scope: Scope, noteId: string) {
  const result = await DemoNote.deleteOne({ _id: noteId, ...(await scopeFilter(actor, scope)) });
  if (result.deletedCount === 0) throw noteNotFound();
  return { deleted: true, id: noteId };
}
