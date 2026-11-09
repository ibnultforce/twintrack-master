import { apiRequest, setAccessToken } from './http';
import type { ModuleAccess, MyModule, Profile } from './types';

interface LoginResult {
  accessToken: string;
  mustChangePassword: boolean;
}

export async function logIn(email: string, password: string): Promise<void> {
  const { accessToken } = await apiRequest<LoginResult>('/auth/login', { method: 'POST', body: { email, password } });
  setAccessToken(accessToken);
}

export async function logOut(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' });
  setAccessToken(null);
}

export const getMyProfile = () => apiRequest<Profile>('/auth/me');

export const updateMyName = (name: string) => apiRequest<Profile>('/auth/me', { method: 'PATCH', body: { name } });

export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  apiRequest('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });

export async function getMyModules(): Promise<MyModule[]> {
  return (await apiRequest<{ modules: MyModule[] }>('/me/modules')).modules;
}

export const getMyModuleAccess = (moduleKey: string) => apiRequest<ModuleAccess>(`/me/permissions/${encodeURIComponent(moduleKey)}`);
