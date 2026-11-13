import { z, type ZodType } from 'zod';

/** A body field that takes one of a fixed set of values, such as a status. */
export interface BodyFieldOption {
  field: string;
  values: (string | number | boolean | null)[];
  /** The field holds a list of these values, such as a resource's actions. */
  isMany: boolean;
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};

type OptionValue = BodyFieldOption['values'][number];
const isOptionValue = (value: unknown): value is OptionValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** The fixed values a field accepts, or none when it takes free input. */
function fixedValues(schema: JsonSchema): OptionValue[] {
  if (schema.enum) return schema.enum.filter(isOptionValue);
  if (schema.const !== undefined && isOptionValue(schema.const)) return [schema.const];
  if (schema.type === 'boolean') return [true, false];
  if (schema.type === 'null') return [null];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!alternatives) return [];
  const parts = alternatives.map(fixedValues);
  // One free alternative, such as "a date or null", means the field isn't a fixed choice.
  if (parts.some((values) => values.length === 0)) return [];
  return [...new Set(parts.flat())];
}

/**
 * The top-level body fields with a fixed set of values, read from the schema the API checks its body with, so the Try
 * dialog offers exactly what the API accepts.
 */
export function listBodyFieldOptions(schema: ZodType): BodyFieldOption[] {
  let options = optionsBySchema.get(schema);
  if (!options) {
    options = readFieldOptions(schema);
    optionsBySchema.set(schema, options);
  }
  return options;
}

// Schemas never change while the API runs, so each is read once.
const optionsBySchema = new WeakMap<ZodType, BodyFieldOption[]>();

function readFieldOptions(schema: ZodType): BodyFieldOption[] {
  let json: JsonSchema;
  try {
    json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  } catch {
    // A schema JSON Schema can't express, such as one built with custom checks, offers no options.
    return [];
  }
  return Object.entries(json.properties ?? {}).flatMap(([field, property]): BodyFieldOption[] => {
    const single = fixedValues(property);
    if (single.length > 0) return [{ field, values: single, isMany: false }];
    const items = property.type === 'array' && property.items ? fixedValues(property.items) : [];
    return items.length > 0 ? [{ field, values: items, isMany: true }] : [];
  });
}

/** Every top-level field a body schema names, such as leadId, whether or not a sample sets it. */
export function listBodyFields(schema: ZodType): string[] {
  try {
    return Object.keys((z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema).properties ?? {});
  } catch {
    return [];
  }
}
