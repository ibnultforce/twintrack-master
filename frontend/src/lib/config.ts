/** Address of the Master API. Next.js writes this value into the browser bundle at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * Shows the example team on the console screens instead of calling the admin routes.
 * Only for use until the admin API is built. See features/console/consoleApi.ts.
 */
export const USE_SAMPLE_CONSOLE_DATA = process.env.NEXT_PUBLIC_CONSOLE_SAMPLE_DATA === 'true';

/** The API refuses shorter passwords. Repeated here so the form can say so before submitting. */
export const MIN_PASSWORD_LENGTH = 12;

export const MASTER_MODULE_KEY = 'master';
