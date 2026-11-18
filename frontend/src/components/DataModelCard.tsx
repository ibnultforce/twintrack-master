'use client';

import type { ReactNode } from 'react';
import type { ModuleSchema, SchemaDefinition, SchemaProperty } from '@/lib/api/types';
import { Card, Pill, type PillTone } from './ui';

const definitionName = (ref: string) => ref.split('/').pop() ?? ref;

/** A short, readable type, such as "Project", "open or done", "list of PersonRef" or "string (date-time)". */
function describeType(property: SchemaProperty): string {
  if (property.$ref) return definitionName(property.$ref);
  if (property.enum) return property.enum.map(String).join(' or ');
  if (property.items) return `list of ${describeType(property.items)}`;
  const type = Array.isArray(property.type) ? property.type.join(' or ') : property.type ?? 'any';
  return property.format ? `${type} (${property.format})` : type;
}

/** The definitions a record builds on through allOf, such as RecordFields. */
const includedDefinitions = (definition: SchemaDefinition) =>
  (definition.allOf ?? []).flatMap((part) => (part.$ref ? [definitionName(part.$ref)] : []));

const FIELD_ACCESS_TONES: Record<string, PillTone> = { protected: 'danger', controlled: 'accent' };

function DefinitionTable({ name, definition }: { name: string; definition: SchemaDefinition }) {
  const properties = Object.entries(definition.properties ?? {});
  const required = new Set(definition.required ?? []);
  const included = includedDefinitions(definition);
  const fieldCount = `${properties.length} field${properties.length === 1 ? '' : 's'}`;
  let body: ReactNode;
  if (properties.length > 0) {
    body = (
      <div className="data-model-table">
        <table>
          <colgroup><col className="col-field" /><col className="col-type" /><col className="col-always" /><col className="col-access" /></colgroup>
          <thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Always</th><th scope="col">Field access</th></tr></thead>
          <tbody>
            {properties.map(([field, property]) => (
              <tr key={field}>
                <td><code className="data-model-field">{field}</code>{property.description ? <div className="meta">{property.description}</div> : null}</td>
                <td><span className="data-model-type">{describeType(property)}</span></td>
                <td>{required.has(field) ? <Pill tone="good">Yes</Pill> : <span className="muted">No</span>}</td>
                <td>{property['x-fieldAccess'] ? <Pill tone={FIELD_ACCESS_TONES[property['x-fieldAccess']] ?? 'neutral'}>{property['x-fieldAccess']}</Pill> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    body = <p className="data-model-empty">{describeType(definition)}</p>;
  }
  return (
    <section className="data-model-definition" aria-label={name}>
      <header className="data-model-head">
        <h3>{name}</h3>
        <span className="meta">{properties.length > 0 ? fieldCount : 'no fields'}{included.length > 0 ? ` · includes ${included.join(', ')}` : ''}</span>
      </header>
      {definition.description ? <p className="data-model-description muted">{definition.description}</p> : null}
      {body}
    </section>
  );
}

/** The module's records as its schema describes them, one table per definition. */
export function DataModelCard({ moduleName, schema, aside }: { moduleName: string; schema: ModuleSchema; aside?: ReactNode }) {
  const definitions = Object.entries(schema.$defs ?? {});
  return (
    <Card title="Data model" aside={aside ?? <span className="note">{definitions.length} definitions</span>}>
      {definitions.length === 0
        ? <p className="empty">{moduleName} has no schema yet. Import one to describe its records for frontend developers.</p>
        : <div className="data-model-grid">{definitions.map(([name, definition]) => <DefinitionTable key={name} name={name} definition={definition} />)}</div>}
    </Card>
  );
}
