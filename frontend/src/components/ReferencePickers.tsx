'use client';

import type { ReactNode } from 'react';
import type { BodyFieldOption, ReferenceChoice, ReferenceOption } from '@/lib/api/types';

/** Readable names for the kinds of record a field can take, as the API names them. */
const LIST_LABELS: Record<string, string> = {
  User: 'people',
  OrgRole: 'org roles',
  Salary: 'salaries',
  AccessProfile: 'profiles',
  Project: 'projects',
  Task: 'tasks',
};

const listLabel = (list: string) => LIST_LABELS[list] ?? list.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

type FieldValue = BodyFieldOption['values'][number];

// Values travel through a <select> as text, so each is written as JSON: "on_hold", true, null.
const encodeValue = (value: unknown) => JSON.stringify(value);
const describeValue = (value: FieldValue) => (value === null ? 'null (clear it)' : String(value));

/** Reads the JSON body as an object, or null when it isn't valid JSON or isn't an object. */
export function readBodyObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The body with one field set, or a value added to the list for a field that holds several. */
function setBodyField(body: Record<string, unknown>, field: string, value: unknown, isMany: boolean): string {
  const current = body[field];
  const encoded = encodeValue(value);
  const next = isMany ? [...(Array.isArray(current) ? current.filter((item) => encodeValue(item) !== encoded) : []), value] : value;
  return JSON.stringify({ ...body, [field]: next }, null, 2);
}

interface PickerProps {
  id: string;
  label: ReactNode;
  options: { value: string; label: string }[];
  selected: string;
  isMany: boolean;
  disabled: boolean;
  onPick: (value: string) => void;
}

function Picker({ id, label, options, selected, isMany, disabled, onPick }: PickerProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select className="input" id={id} value={selected} disabled={disabled} onChange={(event) => { if (event.target.value) onPick(event.target.value); }}>
        <option value="">{isMany ? `Add one of ${options.length}…` : `Choose one of ${options.length}…`}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}

/**
 * A choice beside every field with a known set of values: records from the database for id fields (super admins only),
 * and the fixed values the API accepts, such as a status. Choosing one writes it into the path or the JSON body.
 */
export function ReferencePickers({ choices, references, fieldOptions, parameterValues, body, onPathChange, onBodyChange }: {
  choices: ReferenceChoice[];
  references?: Record<string, ReferenceOption[]>;
  fieldOptions: BodyFieldOption[];
  parameterValues: Record<string, string>;
  /** The body as an object, or null when it isn't valid JSON, which turns the body pickers off. */
  body: Record<string, unknown> | null;
  onPathChange: (field: string, value: string) => void;
  onBodyChange: (bodyText: string) => void;
}) {
  const recordChoices = choices.filter((choice) => (references?.[choice.list] ?? []).length > 0);
  // A field with both is an id field, so the record list wins.
  const idFields = new Set(recordChoices.filter((choice) => choice.location === 'body').map((choice) => choice.field));
  const valueChoices = fieldOptions.filter((option) => !idFields.has(option.field));
  if (recordChoices.length === 0 && valueChoices.length === 0) return null;
  const isBodyBroken = body === null;
  const hasBodyPickers = valueChoices.length > 0 || recordChoices.some((choice) => choice.location === 'body');

  return (
    <fieldset className="reference-pickers">
      <legend>Values to choose from</legend>
      <p className="meta">Choosing one writes it into the request.{isBodyBroken && hasBodyPickers ? ' Fix the JSON body to choose body values.' : ''}</p>
      <div className="reference-grid">
        {recordChoices.map((choice) => {
          const options = references![choice.list]!;
          const current = choice.location === 'path' ? parameterValues[choice.field] : body?.[choice.field];
          // A field holding several adds the chosen one, so its picker always starts empty.
          const selected = !choice.isMany && typeof current === 'string' && options.some((option) => option.id === current) ? current : '';
          return (
            <Picker
              key={`record-${choice.location}-${choice.field}`}
              id={`reference-${choice.location}-${choice.field}`}
              label={<><code>{choice.field}</code> <span className="meta">{choice.location === 'path' ? 'in the path' : choice.isMany ? 'add to the list' : 'in the body'}, from {listLabel(choice.list)}</span></>}
              options={options.map((option) => ({ value: option.id, label: option.label }))}
              selected={selected}
              isMany={choice.isMany}
              disabled={choice.location === 'body' && isBodyBroken}
              onPick={(id) => {
                if (choice.location === 'path') onPathChange(choice.field, id);
                else if (body) onBodyChange(setBodyField(body, choice.field, id, choice.isMany));
              }}
            />
          );
        })}
        {valueChoices.map((option) => {
          const current = body && option.field in body ? encodeValue(body[option.field]) : '';
          const values = option.values.map((value) => ({ value: encodeValue(value), label: describeValue(value) }));
          const selected = !option.isMany && values.some((value) => value.value === current) ? current : '';
          return (
            <Picker
              key={`value-${option.field}`}
              id={`value-${option.field}`}
              label={<><code>{option.field}</code> <span className="meta">{option.isMany ? 'add to the list' : 'in the body'}, accepted values</span></>}
              options={values}
              selected={selected}
              isMany={option.isMany}
              disabled={isBodyBroken}
              onPick={(encoded) => { if (body) onBodyChange(setBodyField(body, option.field, JSON.parse(encoded) as FieldValue, option.isMany)); }}
            />
          );
        })}
      </div>
    </fieldset>
  );
}
