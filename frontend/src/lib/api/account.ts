import { apiRequest, setAccessToken } from './http';
import type { DirectoryEntry, ModuleAccess, MyModule, Profile } from './types';

interface LoginResult {
  accessToken: string;
}

export async function logIn(email: string, password: string): Promise<void> {
  const { accessToken } = await apiRequest<LoginResult>('/auth/login', { method: 'POST', body: { email, password } });
  setAccessToken(accessToken);
}

export async function logOut(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' });
  setAccessToken(null);
}

/** Sets a password from the one-time link emailed to a new person or by a reset. Works without being signed in. */
export const setPasswordWithLink = (token: string, newPassword: string) =>
  apiRequest('/auth/set-password', { method: 'POST', body: { token, newPassword } });

export const getMyProfile = () => apiRequest<Profile>('/auth/me');

export const updateMyName = (name: string) => apiRequest<Profile>('/auth/me', { method: 'PATCH', body: { name } });

export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  apiRequest('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });

/** Confirms the person at the keyboard before showing something sensitive. Refused with wrong_current_password. */
export const verifyMyPassword = (password: string) => apiRequest('/auth/verify-password', { method: 'POST', body: { password } });

/** Says this app is open, so the person shows as online. */
export const sendHeartbeat = () => apiRequest('/me/heartbeat', { method: 'POST' });

/** Ends signing in as someone else, and returns a token for the super admin's own session. */
export async function stopImpersonating(): Promise<void> {
  const { accessToken } = await apiRequest<{ accessToken: string }>('/auth/stop-impersonating', { method: 'POST' });
  setAccessToken(accessToken);
}

export async function getMyModules(): Promise<MyModule[]> {
  return (await apiRequest<{ modules: MyModule[] }>('/me/modules')).modules;
}

export const getMyModuleAccess = (moduleKey: string) => apiRequest<ModuleAccess>(`/me/permissions/${encodeURIComponent(moduleKey)}`);

export const listDirectory = (query: { page: number; pageSize: number; search?: string }) =>
  apiRequest<{ people: DirectoryEntry[]; total: number }>('/directory', { query: { ...query } });
