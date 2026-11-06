import type { z } from 'zod';
import { ApiError } from './errors.js';

export interface FieldError {
  path: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/** A file or request failed validation. Holds every problem, so people can fix them in one go. */
export class ValidationFailure extends Error {
  constructor(
    summary: string,
    readonly errors: FieldError[],
  ) {
    super(`${summary}:\n${errors.map((error) => `  ${error.path || '(file)'}: ${error.message}`).join('\n')}`);
  }
}

export function fieldErrors(issues: z.core.$ZodIssue[], prefix = ''): FieldError[] {
  return issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

/** Checks a request body against its schema, so services only receive values of the expected types. */
export function parseRequestBody<Body>(schema: z.ZodType<Body>, body: unknown): Body {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', fieldErrors(parsed.error.issues));
}

/** For cross-field checks, which must not assume the raw input has the right shape. */
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
