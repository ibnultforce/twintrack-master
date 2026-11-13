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
  /** Sent as it is, with its own content type, such as an image file. Takes the place of body. */
  file?: Blob;
  query?: Record<string, string | number | undefined>;
}

interface SessionListeners {
  onSessionEnded: () => void;
  /** The token for signing in as someone else ran out, so the super admin's own session takes over again. */
  onImpersonationEnded: () => void;
}

/** Kept in memory only, so a script can't read it from storage. A reload gets a new one through the refresh cookie. */
let accessToken: string | null = null;
let listeners: SessionListeners | null = null;
let refreshInFlight: Promise<boolean> | null = null;
/**
 * While a super admin is signed in as someone else, the refresh cookie still belongs to the super admin. Refreshing then
 * would swap identities in the middle of a screen, so an expired token ends the impersonation instead.
 */
let isImpersonating = false;

/** These mean the token itself is the problem, so a refresh can fix them. */
const REFRESHABLE_CODES = new Set(['no_token', 'invalid_token', 'token_expired']);
const TOO_MANY_REQUESTS = 429;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSessionListeners(next: SessionListeners | null): void {
  listeners = next;
}

export function setImpersonating(next: boolean): void {
  isImpersonating = next;
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
  const contentType = options.file ? options.file.type : hasBody ? 'application/json' : undefined;
  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(contentType && { 'Content-Type': contentType }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    body: options.file ?? (hasBody ? JSON.stringify(options.body) : undefined),
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

const NO_CONTENT = 204;

/** Some routes, such as deleting an org role, answer 204 with no body, which isn't JSON to read. */
async function parseSuccess<Result>(response: Response): Promise<Result> {
  if (response.status === NO_CONTENT) return undefined as Result;
  return (await response.json()) as Result;
}

/** Calls the API, refreshing the access token once if it has expired. */
export async function apiRequest<Result>(path: string, options: RequestOptions = {}): Promise<Result> {
  const hadToken = accessToken !== null;
  let response = await send(path, options);
  if (response.ok) return parseSuccess<Result>(response);

  let error = await readError(response);
  if (hadToken && isImpersonating && error.status === 401) {
    listeners?.onImpersonationEnded();
    throw error;
  }
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
  throw error;
}

/** Reads a binary answer, such as a photo, which needs the access token and so can't be a plain image address. */
export async function apiBlob(path: string): Promise<Blob> {
  let response = await send(path, {});
  if (response.status === 401 && accessToken !== null && !isImpersonating && (await refreshAccessToken())) response = await send(path, {});
  if (!response.ok) throw await readError(response);
  return response.blob();
}

export interface TryResult {
  status: number;
  /** The parsed JSON answer, the raw text if it wasn't JSON, or null for no body. */
  body: unknown;
  durationMs: number;
}

/**
 * Sends one request exactly as asked, for trying an API, and returns whatever comes back instead of throwing on a
 * refusal. An expired token is refreshed once, as in apiRequest. The path may include a query string.
 */
export async function tryApiRequest(method: NonNullable<RequestOptions['method']>, path: string, body?: unknown): Promise<TryResult> {
  const started = performance.now();
  let response = await send(path, { method, body });
  if (response.status === 401 && accessToken !== null && isImpersonating) {
    // Refreshing would swap in the super admin's own token under the impersonated screen, as apiRequest explains.
    listeners?.onImpersonationEnded();
  } else if (response.status === 401 && accessToken !== null) {
    const refusal = (await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null;
    if (REFRESHABLE_CODES.has(refusal?.error?.code ?? '') && (await refreshAccessToken())) response = await send(path, { method, body });
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, durationMs: Math.round(performance.now() - started) };
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
