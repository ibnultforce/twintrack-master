'use client';

import type { ReactNode } from 'react';
import type { ModuleSchema, SchemaDefinition, SchemaProperty } from '@/lib/api/types';
import { Card, Pill } from './ui';

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

function DefinitionTable({ name, definition }: { name: string; definition: SchemaDefinition }) {
  const properties = Object.entries(definition.properties ?? {});
  const required = new Set(definition.required ?? []);
  const included = includedDefinitions(definition);
  let body: ReactNode;
  if (properties.length > 0) {
    body = (
      <div className="table-box">
        <table>
          <thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Always</th><th scope="col">Field access</th></tr></thead>
          <tbody>
            {properties.map(([field, property]) => (
              <tr key={field}>
                <td><div className="strong">{field}</div>{property.description ? <div className="meta">{property.description}</div> : null}</td>
                <td>{describeType(property)}</td>
                <td>{required.has(field) ? 'Yes' : 'No'}</td>
                <td>{property['x-fieldAccess'] ? <Pill tone={property['x-fieldAccess'] === 'protected' ? 'danger' : 'neutral'}>{property['x-fieldAccess']}</Pill> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    body = <p className="meta">{describeType(definition)}</p>;
  }
  return (
    <div className="data-model-definition">
      <h3>{name}{included.length > 0 ? <span className="muted"> · includes {included.join(', ')}</span> : null}</h3>
      {definition.description ? <p className="muted">{definition.description}</p> : null}
      {body}
    </div>
  );
}

/** The module's records as its schema describes them, one table per definition. */
export function DataModelCard({ moduleName, schema, aside }: { moduleName: string; schema: ModuleSchema; aside?: ReactNode }) {
  const definitions = Object.entries(schema.$defs ?? {});
  return (
    <Card title="Data model" aside={aside ?? <span className="note">{definitions.length} definitions</span>}>
      {definitions.length === 0
        ? <p className="empty">{moduleName} has no schema yet. Import one to describe its records for frontend developers.</p>
        : definitions.map(([name, definition]) => <DefinitionTable key={name} name={name} definition={definition} />)}
    </Card>
  );
}
