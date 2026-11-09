import { apiRequest } from './http';
import type { AuditEntry, ManageableModule, RegisteredModule, ResourceAction, RoleGrants, RoleTemplate } from './types';

const segment = encodeURIComponent;
const resourcePath = (moduleKey: string, resourceKey: string) => `/modules/${segment(moduleKey)}/resources/${segment(resourceKey)}`;
const rolePath = (moduleKey: string, roleKey: string) => `/roles/${segment(moduleKey)}/${segment(roleKey)}`;

export async function listModules(): Promise<RegisteredModule[]> {
  return (await apiRequest<{ modules: RegisteredModule[] }>('/modules')).modules;
}

export const importModule = (manifest: unknown, password: string) =>
  apiRequest<{ key: string; created: boolean }>('/modules/import', { method: 'POST', body: { manifest, password } });

export const exportModule = (moduleKey: string) => apiRequest<unknown>(`/modules/${segment(moduleKey)}/export`);

export const removeModule = (moduleKey: string) => apiRequest(`/modules/${segment(moduleKey)}`, { method: 'DELETE' });

export interface ResourceDetails {
  label: string;
  actions: ResourceAction[];
  scoped: boolean;
}

export const saveResource = (moduleKey: string, resourceKey: string, details: ResourceDetails) =>
  apiRequest(resourcePath(moduleKey, resourceKey), { method: 'PUT', body: details });

export const removeResource = (moduleKey: string, resourceKey: string) =>
  apiRequest(resourcePath(moduleKey, resourceKey), { method: 'DELETE' });

export const setGrantableActions = (moduleKey: string, resourceKey: string, actions: ResourceAction[]) =>
  apiRequest(`${resourcePath(moduleKey, resourceKey)}/grantable`, { method: 'PUT', body: { actions } });

export async function listRoles(): Promise<RoleTemplate[]> {
  return (await apiRequest<{ roles: RoleTemplate[] }>('/roles')).roles;
}

export async function getManageableRoles(): Promise<ManageableModule[]> {
  return (await apiRequest<{ modules: ManageableModule[] }>('/roles/manageable')).modules;
}

export interface NewRole {
  key: string;
  name: string;
  description?: string;
  grants: RoleGrants;
}

export const addRole = (moduleKey: string, role: NewRole) =>
  apiRequest(`/roles/${segment(moduleKey)}`, { method: 'POST', body: role });

export const updateRole = (moduleKey: string, roleKey: string, changes: Partial<Omit<NewRole, 'key'>>) =>
  apiRequest(rolePath(moduleKey, roleKey), { method: 'PATCH', body: changes });

export const removeRole = (moduleKey: string, roleKey: string) => apiRequest(rolePath(moduleKey, roleKey), { method: 'DELETE' });

export const listActivity = (query: { page: number; pageSize: number; actionPrefix?: string }) =>
  apiRequest<{ total: number; entries: AuditEntry[] }>('/audit', { query: { ...query } });
