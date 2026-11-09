const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
/** Where this app is meant to be opened. It must be listed in the API's ALLOWED_ORIGINS. */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

export interface ApiFieldError {
  path: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: ApiFieldError[] = [],
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

interface SessionListeners {
  onSessionEnded: () => void;
  onPasswordChangeRequired: () => void;
}

/** Kept in memory only, so a script can't read it from storage. A reload gets a new one through the refresh cookie. */
let accessToken: string | null = null;
let listeners: SessionListeners | null = null;
let refreshInFlight: Promise<boolean> | null = null;

/** These mean the token itself is the problem, so a refresh can fix them. */
const REFRESHABLE_CODES = new Set(['no_token', 'invalid_token', 'token_expired']);
const TOO_MANY_REQUESTS = 429;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSessionListeners(next: SessionListeners | null): void {
  listeners = next;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const queryText = params.toString();
  return `${API_URL}${path}${queryText ? `?${queryText}` : ''}`;
}

function send(path: string, options: RequestOptions): Promise<Response> {
  const hasBody = options.body !== undefined;
  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(hasBody && { 'Content-Type': 'application/json' }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
}

async function readError(response: Response): Promise<ApiRequestError> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; fields?: ApiFieldError[] };
  } | null;
  return new ApiRequestError(
    response.status,
    payload?.error?.code ?? 'unknown_error',
    payload?.error?.message ?? 'Something went wrong.',
    payload?.error?.fields ?? [],
  );
}

async function requestRefresh(): Promise<boolean> {
  const response = await send('/auth/refresh', { method: 'POST' });
  // An outage or rate limit says nothing about the session, so it mustn't sign anyone out.
  if (response.status >= 500 || response.status === TOO_MANY_REQUESTS) throw await readError(response);
  if (!response.ok) {
    setAccessToken(null);
    return false;
  }
  const { accessToken: newToken } = (await response.json()) as { accessToken: string };
  setAccessToken(newToken);
  return true;
}

/** Tabs and parallel calls share one refresh, so a burst of expired calls doesn't replace the cookie repeatedly. */
export function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function parseSuccess<Result>(response: Response): Promise<Result> {
  return (await response.json()) as Result;
}

/** Calls the API, refreshing the access token once if it has expired. */
export async function apiRequest<Result>(path: string, options: RequestOptions = {}): Promise<Result> {
  const hadToken = accessToken !== null;
  let response = await send(path, options);
  if (response.ok) return parseSuccess<Result>(response);

  let error = await readError(response);
  if (hadToken && error.status === 401 && REFRESHABLE_CODES.has(error.code)) {
    if (!(await refreshAccessToken())) {
      listeners?.onSessionEnded();
      throw error;
    }
    response = await send(path, options);
    if (response.ok) return parseSuccess<Result>(response);
    error = await readError(response);
  }

  if (hadToken && error.status === 401) listeners?.onSessionEnded();
  if (error.code === 'password_change_required') listeners?.onPasswordChangeRequired();
  throw error;
}

/** A message fit to show someone, including which fields were refused. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.fields.length === 0) return error.message;
    return `${error.message} ${error.fields.map((field) => (field.path ? `${field.path}: ${field.message}` : field.message)).join('; ')}.`;
  }
  return describeConnectionProblem();
}

/** The browser reports a blocked origin and a stopped API the same way, so the address is the only way to tell them apart. */
export function describeConnectionProblem(): string {
  const currentOrigin = window.location.origin;
  if (APP_URL && currentOrigin !== APP_URL) {
    return `TwinTrack can't connect from ${currentOrigin}. Open it at ${APP_URL} instead.`;
  }
  return 'The API can\'t be reached. Check that it is running, then try again.';
}
