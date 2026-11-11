import { apiRequest } from './http';
import type { AccessProfile, AuditEntry, Grants, OrgRole, RegisteredModule, ResourceAction } from './types';

const segment = encodeURIComponent;
const resourcePath = (moduleKey: string, resourceKey: string) => `/modules/${segment(moduleKey)}/resources/${segment(resourceKey)}`;
const profilePath = (profileId: string) => `/access-profiles/${segment(profileId)}`;

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

export async function listProfiles(): Promise<AccessProfile[]> {
  return (await apiRequest<{ profiles: AccessProfile[] }>('/access-profiles')).profiles;
}

export interface ProfileDetails {
  name: string;
  description?: string | null;
  grants: Record<string, Grants | '*'>;
}

export const createProfile = (details: ProfileDetails) => apiRequest<AccessProfile>('/access-profiles', { method: 'POST', body: details });

export const updateProfile = (profileId: string, changes: Partial<ProfileDetails>) =>
  apiRequest<AccessProfile>(profilePath(profileId), { method: 'PATCH', body: changes });

export const removeProfile = (profileId: string) => apiRequest(profilePath(profileId), { method: 'DELETE' });

export async function listOrgRoles(): Promise<OrgRole[]> {
  return (await apiRequest<{ orgRoles: OrgRole[] }>('/org-roles')).orgRoles;
}

export interface OrgRoleDetails {
  name: string;
  description?: string | null;
  /** Leave it out only for the root, while the tree is empty. */
  parentId?: string;
}

export const createOrgRole = (details: OrgRoleDetails) => apiRequest<OrgRole>('/org-roles', { method: 'POST', body: details });

/** A new parentId moves the role and everything below it. */
export const updateOrgRole = (orgRoleId: string, changes: Partial<OrgRoleDetails>) =>
  apiRequest<OrgRole>(`/org-roles/${segment(orgRoleId)}`, { method: 'PATCH', body: changes });

export const removeOrgRole = (orgRoleId: string) => apiRequest(`/org-roles/${segment(orgRoleId)}`, { method: 'DELETE' });

export const listActivity = (query: { page: number; pageSize: number; actionPrefix?: string }) =>
  apiRequest<{ total: number; entries: AuditEntry[] }>('/audit', { query: { ...query } });
