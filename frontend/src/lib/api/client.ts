import { API_URL } from '@/lib/config';

export interface FieldError {
  path: string;
  message: string;
}

/** Any failed API call. `message` comes from the API or from this file, so it's safe to show to people. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Public routes send no token, and a 401 from them isn't answered with a refresh. */
  isPublic?: boolean;
}

interface TokenResponse {
  accessToken: string;
}

const NETWORK_ERROR_MESSAGE = 'Could not reach TwinTrack. Check your connection and try again.';
const UNREADABLE_ERROR_MESSAGE = 'Something went wrong. Try again.';

// Kept in memory only, so scripts can't read it from storage. A page reload gets a new one using the refresh cookie.
let accessToken: string | null = null;
let refreshInFlight: Promise<void> | null = null;
let notifySessionEnded: () => void = () => {};

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSessionEndedListener(listener: () => void): void {
  notifySessionEnded = listener;
}

async function readErrorResponse(response: Response): Promise<ApiRequestError> {
  try {
    const { error } = (await response.json()) as { error: { code: string; message: string; fields?: FieldError[] } };
    return new ApiRequestError(response.status, error.code, error.message, error.fields);
  } catch {
    return new ApiRequestError(response.status, 'unreadable_response', UNREADABLE_ERROR_MESSAGE);
  }
}

async function send<ResponseBody>(path: string, { method = 'GET', body, isPublic }: RequestOptions): Promise<ResponseBody> {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!isPublic && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }

  if (!response.ok) throw await readErrorResponse(response);
  return (await response.json()) as ResponseBody;
}

/** Gets a new access token using the refresh cookie. Calls made at the same moment share one refresh. */
export function refreshAccessToken(): Promise<void> {
  refreshInFlight ??= send<TokenResponse>('/auth/refresh', { method: 'POST', isPublic: true })
    .then(({ accessToken: newToken }) => setAccessToken(newToken))
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function endSessionIfRefused(error: unknown): void {
  if (error instanceof ApiRequestError && error.status === 401) {
    setAccessToken(null);
    notifySessionEnded();
  }
}

/** Calls the API. A signed call that gets a 401 refreshes the token and retries once, then ends the session. */
export async function apiRequest<ResponseBody>(path: string, options: RequestOptions = {}): Promise<ResponseBody> {
  if (options.isPublic) return send<ResponseBody>(path, options);

  try {
    return await send<ResponseBody>(path, options);
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
  }

  try {
    await refreshAccessToken();
    return await send<ResponseBody>(path, options);
  } catch (error) {
    endSessionIfRefused(error);
    throw error;
  }
}

/** The message for one form field, or undefined. */
export function fieldErrorMessage(error: unknown, fieldPath: string): string | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const message = error.fields.find((field) => field.path === fieldPath)?.message;
  return message;
}

/** Text to show for any caught error, without exposing unexpected technical details. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : UNREADABLE_ERROR_MESSAGE;
}
