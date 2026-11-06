import { apiRequest } from '@/lib/api/client';

export interface Profile {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: string;
  superAdmin: boolean;
  mustChangePassword: boolean;
  manager: { id: string; name: string } | null;
}

export interface AccessibleModule {
  key: string;
  name: string;
  description?: string;
  frontendUrl: string | null;
  roleName: string | null;
}

export type PermissionScope = 'own' | 'team' | 'all';
/** Permission to scope, for example { "user.read": "all" }. */
export type PermissionMap = Record<string, PermissionScope>;

export interface ModuleAccess {
  module: string;
  hasAccess: boolean;
  role: string | null;
  roleName: string | null;
  permissions: PermissionMap;
  specialPrivileges: string[];
}

interface LoginResponse {
  accessToken: string;
  mustChangePassword: boolean;
}

export const login = (credentials: { email: string; password: string }) =>
  apiRequest<LoginResponse>('/auth/login', { method: 'POST', body: credentials, isPublic: true });

export const logout = () => apiRequest<{ signedOut: boolean }>('/auth/logout', { method: 'POST', isPublic: true });

export const getProfile = () => apiRequest<Profile>('/auth/me');

export const updateOwnName = (name: string) => apiRequest<Profile>('/auth/me', { method: 'PATCH', body: { name } });

export const changeOwnPassword = (passwords: { currentPassword: string; newPassword: string }) =>
  apiRequest<{ passwordChanged: boolean }>('/auth/change-password', { method: 'POST', body: passwords });

export const listMyModules = () => apiRequest<{ modules: AccessibleModule[] }>('/me/modules');

export const getMyModuleAccess = (moduleKey: string) =>
  apiRequest<ModuleAccess>(`/me/permissions/${encodeURIComponent(moduleKey)}`);

/** Says whether the API and database are up. Throws if they aren't. */
export const checkApiHealth = () => apiRequest<unknown>('/health', { isPublic: true });
