import { apiRequest } from '@/lib/api/client';
import type {
  ActivityPage,
  ConsoleApi,
  ConsoleUser,
  ModuleAccessOptions,
  RegisteredModule,
  RoleTemplate,
  TemporaryPasswordResult,
  UserPage,
} from './consoleTypes';

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  return `${path}?${params.toString()}`;
}

const userPath = (id: string) => `/users/${encodeURIComponent(id)}`;

/** Calls the admin routes listed in manifests/master.manifest.json. */
export const liveConsoleApi: ConsoleApi = {
  listUsers: (query) => apiRequest<UserPage>(withQuery('/users', { ...query })),
  getUser: (id) => apiRequest<ConsoleUser>(userPath(id)),
  createUser: (details) => apiRequest<TemporaryPasswordResult>('/users', { method: 'POST', body: details }),
  updateUser: (id, details) => apiRequest<ConsoleUser>(userPath(id), { method: 'PATCH', body: details }),
  setUserStatus: (id, status) => apiRequest<ConsoleUser>(`${userPath(id)}/status`, { method: 'PATCH', body: { status } }),
  resetUserPassword: (id) => apiRequest<TemporaryPasswordResult>(`${userPath(id)}/reset-password`, { method: 'POST' }),
  listAccessOptions: async () => (await apiRequest<{ modules: ModuleAccessOptions[] }>('/users/access-options')).modules,
  setUserRole: (id, moduleKey, roleKey) =>
    apiRequest<ConsoleUser>(`${userPath(id)}/roles`, { method: 'PATCH', body: { module: moduleKey, role: roleKey } }),
  setUserPrivileges: (id, moduleKey, permissions) =>
    apiRequest<ConsoleUser>(`${userPath(id)}/privileges`, { method: 'PUT', body: { module: moduleKey, permissions } }),
  listRoles: async () => (await apiRequest<{ roles: RoleTemplate[] }>('/roles')).roles,
  listModules: async () => (await apiRequest<{ modules: RegisteredModule[] }>('/modules')).modules,
  importModule: (manifest) => apiRequest<RegisteredModule>('/modules/import', { method: 'POST', body: manifest }),
  removeModule: async (key) => {
    await apiRequest<unknown>(`/modules/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },
  listActivity: (query) => apiRequest<ActivityPage>(withQuery('/audit', { ...query })),
};
