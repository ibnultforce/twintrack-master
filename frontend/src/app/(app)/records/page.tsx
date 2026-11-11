'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Card, Chips, Loaded, Notice, PageHead, Pagination } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { createRecord, deleteRecord, getRecordHistory, listReadableObjects, listRecords, restoreRecord, updateRecord } from '@/lib/api/records';
import type { CustomRecordView, ReadableObject } from '@/lib/api/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

const PAGE_SIZE = 20;

type Field = ReadableObject['fields'][number];

function showValue(field: Field, value: unknown): string {
  if (value === undefined || value === null || value === '') return '·';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Turns what was typed into the value the API expects for the field's type. Blank means no value. */
function readInput(field: Field, raw: string | boolean): unknown {
  if (field.type === 'boolean') return raw === true;
  const text = String(raw).trim();
  if (!text) return null;
  return field.type === 'number' ? Number(text) : text;
}

function RecordDialog({ object, record, onSaved, onClose }: { object: ReadableObject; record?: CustomRecordView; onSaved: () => void; onClose: () => void }) {
  const [inputs, setInputs] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(object.fields.map((field) => {
      const value = record?.values[field.key];
      return [field.key, field.type === 'boolean' ? value === true : value === undefined || value === null ? '' : String(value)];
    })),
  );
  const [error, setError] = useState('');
  // A create-only field can be filled in on a new record but not changed afterwards.
  const canSet = (field: (typeof object.fields)[number]) => (record ? field.editable : field.creatable);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const values: Record<string, unknown> = {};
    for (const field of object.fields) {
      if (!canSet(field)) continue;
      const value = readInput(field, inputs[field.key] ?? '');
      // A new record leaves out blanks. A change sends them as null, which clears the field.
      if (value !== null || record) values[field.key] = value;
    }
    try {
      if (record) await updateRecord(object.module, object.key, record.id, values, record.version);
      else await createRecord(object.module, object.key, values);
      onSaved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={record ? `Edit ${object.label.toLowerCase()} record` : `New ${object.label.toLowerCase()} record`} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        {object.fields.map((field) => {
          const id = `field-${field.key}`;
          const value = inputs[field.key];
          const update = (next: string | boolean) => setInputs({ ...inputs, [field.key]: next });
          const label = `${field.label}${field.required ? ' (required)' : ''}${canSet(field) ? '' : ' (read only)'}`;
          if (field.type === 'boolean') {
            return <label className="check" key={field.key}><input type="checkbox" id={id} checked={value === true} disabled={!canSet(field)} onChange={(event) => update(event.target.checked)} />{label}</label>;
          }
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              {field.type === 'select' ? (
                <select className="input" id={id} value={String(value ?? '')} disabled={!canSet(field)} onChange={(event) => update(event.target.value)}>
                  <option value="">None</option>
                  {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input className="input" id={id} autoComplete="off" type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={String(value ?? '')} disabled={!canSet(field)} required={field.required && !record} onChange={(event) => update(event.target.value)} />
              )}
            </div>
          );
        })}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{record ? 'Save' : 'Add record'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ object, record, onClose }: { object: ReadableObject; record: CustomRecordView; onClose: () => void }) {
  const history = useLoad(() => getRecordHistory(object.module, object.key, record.id), [record.id]);
  const labelOf = (key: string) => object.fields.find((field) => field.key === key)?.label ?? key;
  return (
    <Dialog title="History" onClose={onClose}>
      <Loaded state={history}>
        {(entries) => (
          <ul className="history-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <div className="strong">{entry.action[0]!.toUpperCase() + entry.action.slice(1)} by {entry.actorName}</div>
                <div className="meta">{formatTime(entry.at)}</div>
                {entry.changes.map((change) => (
                  <div className="meta" key={change.field}>{labelOf(change.field)}: {String(change.from ?? '·')} → {String(change.to ?? '·')}</div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Loaded>
      <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

type RecordsDialog = { kind: 'new' } | { kind: 'edit' | 'history' | 'delete'; record: CustomRecordView } | null;

/** Records of the custom objects an admin defined. Everything shown and allowed here comes from the person's access. */
export default function RecordsPage() {
  const objects = useLoad(listReadableObjects, []);
  const [chosen, setChosen] = useState('');
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);
  const [dialog, setDialog] = useState<RecordsDialog>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const object = objects.data?.find((candidate) => `${candidate.module}.${candidate.key}` === chosen) ?? objects.data?.[0];
  const records = useLoad(
    async () => (object ? listRecords(object.module, object.key, { page, pageSize: PAGE_SIZE, deleted: showDeleted }) : { total: 0, records: [] }),
    [object?.module, object?.key, page, showDeleted],
    `${object?.module}.${object?.key}:${showDeleted}`,
  );

  return (
    <>
      <PageHead title="Records" subtitle="Records of the objects your organisation defined" />
      <Loaded state={objects}>
        {(list) => (object ? (
          <>
            <div className="toolbar">
              <Chips label="Choose an object" value={`${object.module}.${object.key}`} onChange={(value) => { setChosen(value); setPage(1); setShowDeleted(false); }} options={list.map((candidate) => ({ value: `${candidate.module}.${candidate.key}`, label: `${candidate.label} (${candidate.moduleName})` }))} />
              {object.can.delete ? <label className="check"><input type="checkbox" checked={showDeleted} onChange={(event) => { setShowDeleted(event.target.checked); setPage(1); }} />Show the recycle bin</label> : null}
              {object.can.create && !showDeleted ? <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>+ New record</button> : null}
            </div>
            {outcome ? <Notice tone="good">{outcome}</Notice> : null}
            <Loaded state={records}>
              {({ total, records: rows }) => (
                <Card title={showDeleted ? `${object.label} in the recycle bin` : object.label} aside={<span className="note">{total} records</span>}>
                  {rows.length === 0 ? <p className="empty">{showDeleted ? 'The recycle bin is empty.' : 'No records yet.'}</p> : (
                    <>
                      <div className="table-box">
                        <table>
                          <thead>
                            <tr>{object.fields.map((field) => <th scope="col" key={field.key}>{field.label}</th>)}<th scope="col">Changed</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
                          </thead>
                          <tbody>
                            {rows.map((record) => (
                              <tr key={record.id}>
                                {object.fields.map((field) => <td key={field.key}>{showValue(field, record.values[field.key])}</td>)}
                                <td className="meta">{formatTime(record.updatedAt)}</td>
                                <td>
                                  <div className="resource-actions">
                                    {showDeleted ? (
                                      <button type="button" className="link" onClick={() => void restoreRecord(object.module, object.key, record.id).then(() => { setOutcome('Restored.'); records.reload(); })}>Restore</button>
                                    ) : (
                                      <>
                                        {object.can.update ? <button type="button" className="link" onClick={() => setDialog({ kind: 'edit', record })}>Edit</button> : null}
                                        <button type="button" className="link" onClick={() => setDialog({ kind: 'history', record })}>History</button>
                                        {object.can.delete ? <button type="button" className="link" onClick={() => setDialog({ kind: 'delete', record })}>Delete</button> : null}
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
                    </>
                  )}
                </Card>
              )}
            </Loaded>

            {dialog?.kind === 'new' ? <RecordDialog object={object} onSaved={() => { setOutcome('Record added.'); records.reload(); }} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === 'edit' ? <RecordDialog object={object} record={dialog.record} onSaved={() => { setOutcome('Saved.'); records.reload(); }} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === 'history' ? <HistoryDialog object={object} record={dialog.record} onClose={() => setDialog(null)} /> : null}
            {dialog?.kind === 'delete' ? <ConfirmDialog title="Delete this record?" text="It moves to the recycle bin, where it can be restored." confirmLabel="Delete" isDanger onClose={() => setDialog(null)} onConfirm={async () => { await deleteRecord(object.module, object.key, dialog.record.id); setOutcome('Moved to the recycle bin.'); records.reload(); }} /> : null}
          </>
        ) : <section className="card"><p className="empty">There are no custom objects you can read yet.</p></section>)}
      </Loaded>
    </>
  );
}
