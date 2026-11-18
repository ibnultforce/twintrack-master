import { apiBlob, apiRequest } from './http';
import type { AccessProfile, FrontendSettings, ApiAccessRule, AuditEntry, Grants, ModuleApiRoute, ModuleSchema, OrgRole, RegisteredModule, ResourceAction } from './types';

const segment = encodeURIComponent;
const resourcePath = (moduleKey: string, resourceKey: string) => `/modules/${segment(moduleKey)}/resources/${segment(resourceKey)}`;
const profilePath = (profileId: string) => `/access-profiles/${segment(profileId)}`;

export async function listModules(): Promise<RegisteredModule[]> {
  return (await apiRequest<{ modules: RegisteredModule[] }>('/modules')).modules;
}

/** What an import or removal did to the repo's manifests/ and module pack. Only a local development server writes them. */
export interface ModuleFilesReport {
  synced: boolean;
  written: string[];
  removed: string[];
  unchanged: string[];
  pack: { rebuilt: boolean; message?: string };
  /** Routes the manifest lists that the backend doesn't serve yet. */
  routesWithoutCode: string[];
  warning?: string;
}

export type ModuleChangeKind = 'added' | 'removed' | 'changed';

/** One thing an import changed, and where the code and docs need work to match it. */
export interface ModuleChangeItem {
  kind: ModuleChangeKind;
  subject: string;
  detail?: string;
  where: string[];
}

/** What one manifest or schema import changed. Pending until a developer marks it done. */
export interface ModuleChange {
  id: string;
  module: string;
  moduleName: string;
  source: 'manifest' | 'schema';
  versionBefore: string | null;
  versionAfter: string;
  items: ModuleChangeItem[];
  changedAt: string;
  changedByName?: string;
  status: 'pending' | 'done';
  doneAt?: string;
  doneByName?: string;
}

/** Where a local development server wrote the module's list of changes still to build. */
export interface ChangeLogReport {
  path: string;
  outcome: 'written' | 'removed' | 'unchanged' | 'failed';
}

interface ImportChanges {
  change: ModuleChange | null;
  changeLog: ChangeLogReport | null;
}

export const importModule = (manifest: unknown, password: string) =>
  apiRequest<{ key: string; created: boolean; files: ModuleFilesReport } & ImportChanges>('/modules/import', { method: 'POST', body: { manifest, password } });

export const listModuleChanges = (moduleKey: string, status: 'pending' | 'done') =>
  apiRequest<{ changes: ModuleChange[]; total: number; pending: number }>(`/modules/${segment(moduleKey)}/changes`, { query: { status, pageSize: 50 } });

export const markModuleChangeDone = (moduleKey: string, changeId: string) =>
  apiRequest<{ change: ModuleChange; changeLog: ChangeLogReport | null }>(`/modules/${segment(moduleKey)}/changes/${segment(changeId)}/done`, { method: 'POST' });

export const exportModule = (moduleKey: string) => apiRequest<unknown>(`/modules/${segment(moduleKey)}/export`);

/** The module's data model as JSON Schema, as loaded in the database. */
export const getModuleSchema = (moduleKey: string) => apiRequest<ModuleSchema>(`/modules/${segment(moduleKey)}/schema`);

export const importModuleSchema = (moduleKey: string, schema: unknown) =>
  apiRequest<{ key: string; definitions: number; files: ModuleFilesReport } & ImportChanges>(`/modules/${segment(moduleKey)}/schema`, { method: 'PUT', body: { schema } });

export const removeModule = (moduleKey: string) =>
  apiRequest<{ removed: true; key: string; affectedUsers: number; files: ModuleFilesReport }>(`/modules/${segment(moduleKey)}`, { method: 'DELETE' });

const listPaths = (paths: string[]) => paths.join(', ');

/** Plain sentences saying where a module change went, and what still needs doing by hand. */
export function describeModuleFiles(report: ModuleFilesReport): { tone: 'good' | 'warning'; text: string }[] {
  const notes: { tone: 'good' | 'warning'; text: string }[] = [];
  if (report.synced) {
    const parts = [
      report.written.length > 0 ? `Saved to ${listPaths(report.written)}.` : '',
      report.removed.length > 0 ? `Deleted ${listPaths(report.removed)}.` : '',
      report.unchanged.length > 0 ? `${listPaths(report.unchanged)} already matched.` : '',
      report.pack.rebuilt ? 'The frontend pack was rebuilt.' : '',
    ].filter(Boolean);
    if (report.written.length + report.removed.length > 0) parts.push('Commit these files in twintrack-master.');
    if (parts.length > 0) notes.push({ tone: 'good', text: parts.join(' ') });
    if (!report.pack.rebuilt && report.written.length > 0 && report.pack.message) notes.push({ tone: 'warning', text: `The frontend pack was not rebuilt: ${report.pack.message}` });
  }
  if (report.warning) notes.push({ tone: 'warning', text: report.warning });
  if (report.routesWithoutCode.length > 0) {
    notes.push({ tone: 'warning', text: `These routes have no backend code yet, so they answer 404 until it's built: ${listPaths(report.routesWithoutCode)}.` });
  }
  return notes;
}

/** A sentence about the changes an import recorded for developers to build, or null when it changed nothing. */
export function describeImportChanges({ change, changeLog }: ImportChanges): { tone: 'good' | 'warning'; text: string } | null {
  if (!change) return null;
  const count = `${change.items.length} change${change.items.length === 1 ? '' : 's'}`;
  const file = changeLog?.outcome === 'written' || changeLog?.outcome === 'unchanged' ? ` and in ${changeLog.path}` : '';
  const failed = changeLog?.outcome === 'failed' ? ` ${changeLog.path} could not be written.` : '';
  return { tone: 'warning', text: `${count} to build are listed under "Changes to build"${file}.${failed}` };
}

export interface ResourceDetails {
  label: string;
  actions: ResourceAction[];
  scoped: boolean;
}

export const saveResource = (moduleKey: string, resourceKey: string, details: ResourceDetails) =>
  apiRequest(resourcePath(moduleKey, resourceKey), { method: 'PUT', body: details });

export const removeResource = (moduleKey: string, resourceKey: string) =>
  apiRequest(resourcePath(moduleKey, resourceKey), { method: 'DELETE' });

export interface RouteAccessChange {
  method: string;
  path: string;
  access: ApiAccessRule;
  permission?: string;
}

/** Super admins only: changes who may call one API, from the next request on. */
export const changeRouteAccess = (moduleKey: string, change: RouteAccessChange) =>
  apiRequest<{ route: ModuleApiRoute }>(`/modules/${segment(moduleKey)}/route-access`, { method: 'PUT', body: change });

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

export interface ModulePackFile {
  /** Relative to the pack, such as `api/manifest.json`. */
  path: string;
  size: number;
}

/** The module's frontend handoff pack: what Claude Code or a developer needs to build its frontend. */
export async function listModulePackFiles(moduleKey: string): Promise<ModulePackFile[]> {
  return (await apiRequest<{ files: ModulePackFile[] }>(`/modules/${segment(moduleKey)}/pack`)).files;
}

export const downloadModulePackFile = (moduleKey: string, path: string) =>
  apiBlob(`/modules/${segment(moduleKey)}/pack/file?path=${segment(path)}`);

export interface FrontendSettingsChange {
  frontendUrl: string | null;
  redirectUrls: string[];
  allowedOrigins: string[];
}

/** Super admins only: where a module's frontend lives, where sign-in codes may go, and which addresses may call the API. */
export const saveFrontendSettings = (moduleKey: string, change: FrontendSettingsChange) =>
  apiRequest<{ frontendSettings: FrontendSettings }>(`/modules/${segment(moduleKey)}/frontend`, { method: 'PUT', body: change });

/** A one-time code for opening a module's frontend, already added to the address to send the browser to. */
export const createHandoff = (moduleKey: string) =>
  apiRequest<{ redirectTo: string; expiresIn: number }>(`/modules/${segment(moduleKey)}/handoff`, { method: 'POST', body: {} });
