// Signing in and sending requests, shared by the route and account views.
const PASSWORD_PLACEHOLDER = 'YOUR_PASSWORD';

const tokens = new Map();
let currentEmail = null;
let currentPassword = '';

export class CouldNotSignIn extends Error {}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const personName = (email) => email.charAt(0).toUpperCase() + email.slice(1, email.indexOf('@'));

export const signedInEmail = () => currentEmail;

async function readResponse(response) {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text), text };
  } catch {
    return { status: response.status, body: null, text };
  }
}

export async function signIn(email, password = currentPassword) {
  const response = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { status, body } = await readResponse(response);
  if (status !== 200) throw new CouldNotSignIn(body?.error?.message ?? `The API answered ${status}.`);
  tokens.set(email, body.accessToken);
  return body;
}

/** Signs in as the person using the page, who everything then runs as unless a scenario names someone else. */
export async function logIn(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  const session = await signIn(normalizedEmail, password);
  currentEmail = normalizedEmail;
  currentPassword = password;
  return session;
}

export async function logOut() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  tokens.clear();
  currentEmail = null;
  currentPassword = '';
}

async function tokenFor(email) {
  if (!tokens.has(email)) await signIn(email);
  return tokens.get(email);
}

async function sendOnce(request) {
  const headers = {};
  if (request.literalToken) headers.Authorization = `Bearer ${request.literalToken}`;
  if (request.as) headers.Authorization = `Bearer ${await tokenFor(request.as)}`;
  if (request.body) headers['Content-Type'] = 'application/json';
  const usesCookie = request.cookie || request.path === '/auth/login';
  const response = await fetch(request.path, {
    method: request.method,
    headers,
    credentials: usesCookie ? 'same-origin' : 'omit',
    body: request.body?.split(PASSWORD_PLACEHOLDER).join(currentPassword),
  });
  return readResponse(response);
}

/** Sends a request as request.as. A saved token can expire or lose its session to another test, so that signs in again. */
export async function send(request, expectedStatus) {
  const answer = await sendOnce(request);
  const code = answer.body?.error?.code;
  if (request.as && answer.status === 401 && expectedStatus !== 401 && (code === 'token_expired' || code === 'session_revoked')) {
    tokens.delete(request.as);
    return sendOnce(request);
  }
  return answer;
}

export const describeFailure = (error) =>
  error instanceof CouldNotSignIn
    ? `Couldn't sign in: ${error.message} If the password is right, another test may have changed this account.`
    : "Couldn't reach the API. Check that the link still works.";
