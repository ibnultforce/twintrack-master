'use client';

import { useState, type FormEvent } from 'react';
import { describeError } from '@/lib/api/http';
import { addCustomObject, updateCustomObject, type ObjectDefinition } from '@/lib/api/records';
import type { CustomFieldDefinition, CustomFieldType, ModuleResource } from '@/lib/api/types';
import { Dialog } from './Dialog';
import { Notice, TextField } from './ui';

const FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'select', label: 'Choice list' },
];

interface FieldRow extends CustomFieldDefinition {
  /** Options as typed, separated by commas, for a choice list. */
  optionsText: string;
}

const emptyField = (): FieldRow => ({ key: '', label: '', type: 'text', required: false, tracked: true, protected: false, optionsText: '' });

/** Makes a field key from its label, such as "Start date" to "startDate". */
const keyFromLabel = (label: string) =>
  label.trim().replace(/[^a-zA-Z0-9]+(.)?/g, (_match, next: string | undefined) => (next ? next.toUpperCase() : '')).replace(/^[^a-zA-Z]+/, '').replace(/^./, (first) => first.toLowerCase());

/** Defines a custom object, or changes one. The API checks every rule, and this only builds the definition. */
export function CustomObjectDialog({ moduleKey, existing, onSaved, onClose }: { moduleKey: string; existing?: ModuleResource; onSaved: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [objectKey, setObjectKey] = useState(existing?.key ?? '');
  const [sharingModel, setSharingModel] = useState<ObjectDefinition['sharingModel']>(existing?.sharingModel ?? 'private');
  const [fields, setFields] = useState<FieldRow[]>(() =>
    existing?.fields?.length ? existing.fields.map((field) => ({ ...field, optionsText: (field.options ?? []).join(', ') })) : [emptyField()],
  );
  const [error, setError] = useState('');

  const changeField = (index: number, change: Partial<FieldRow>) =>
    setFields(fields.map((field, position) => (position === index ? { ...field, ...change } : field)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const definition: ObjectDefinition = {
      label: label.trim(),
      sharingModel,
      fields: fields.map(({ optionsText, ...field }) => ({
        ...field,
        key: field.key || keyFromLabel(field.label),
        ...(field.type === 'select' ? { options: optionsText.split(',').map((option) => option.trim()).filter(Boolean) } : { options: undefined }),
      })),
    };
    try {
      if (existing) await updateCustomObject(moduleKey, existing.key, definition);
      else await addCustomObject(moduleKey, objectKey.trim() || keyFromLabel(label), definition);
      onSaved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={existing ? `Edit ${existing.label}` : 'New custom object'} onClose={onClose} isWide>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <TextField id="object-label" label="Name, such as Trainings" required value={label} onChange={setLabel} />
        {existing ? null : <TextField id="object-key" label="Key" hint="Letters and numbers, starting with a lowercase letter. Leave blank to make one from the name." value={objectKey} onChange={setObjectKey} />}
        <div className="field">
          <label htmlFor="object-sharing">Who sees records nobody has shared</label>
          <select className="input" id="object-sharing" value={sharingModel} onChange={(event) => setSharingModel(event.target.value as ObjectDefinition['sharingModel'])}>
            <option value="private">Only people whose scope reaches the owner</option>
            <option value="publicRead">Everyone who can read this object</option>
            <option value="publicReadWrite">Everyone who can read or edit this object</option>
          </select>
        </div>
        <fieldset>
          <legend>Fields</legend>
          {fields.map((field, index) => (
            <div className="object-field" key={index}>
              <input className="input" aria-label={`Field ${index + 1} name`} placeholder="Field name" required value={field.label} onChange={(event) => changeField(index, { label: event.target.value })} />
              <select className="input" aria-label={`Field ${index + 1} type`} value={field.type} disabled={Boolean(existing && existing.fields?.some((saved) => saved.key === field.key))} onChange={(event) => changeField(index, { type: event.target.value as CustomFieldType })}>
                {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
              {field.type === 'select' ? <input className="input wide" aria-label={`Field ${index + 1} choices`} placeholder="Choices, separated by commas" value={field.optionsText} onChange={(event) => changeField(index, { optionsText: event.target.value })} /> : null}
              <div className="object-field-options">
                <label className="check"><input type="checkbox" checked={field.required ?? false} onChange={(event) => changeField(index, { required: event.target.checked })} />Required</label>
                <label className="check"><input type="checkbox" checked={field.tracked ?? false} onChange={(event) => changeField(index, { tracked: event.target.checked })} />Keep history</label>
                <label className="check"><input type="checkbox" checked={field.protected ?? false} onChange={(event) => changeField(index, { protected: event.target.checked })} />Protected</label>
                <button type="button" className="link" aria-label={`Remove field ${index + 1}`} disabled={fields.length === 1} onClick={() => setFields(fields.filter((_field, position) => position !== index))}>Remove field</button>
              </div>
            </div>
          ))}
          <button type="button" className="link" onClick={() => setFields([...fields, emptyField()])}>+ Add a field</button>
        </fieldset>
        <p className="note">A protected field is hidden unless a profile gives access to it. History keeps every change to the fields ticked.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!label.trim()}>{existing ? 'Save' : 'Create object'}</button>
        </div>
      </form>
    </Dialog>
  );
}
