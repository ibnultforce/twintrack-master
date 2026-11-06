import type { FieldError } from './validation.js';

/** An expected failure that is safe to show the caller. The app's error handler turns it into a JSON response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: FieldError[],
  ) {
    super(message);
  }
}
