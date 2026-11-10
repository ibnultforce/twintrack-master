import { apiRequest } from './http';
import type { AccessOption, AddablePerson, ModulePerson, TemporaryPasswordResult, User, UserDetails, UserStatus } from './types';

/** The most the API returns in one page. */
const MAX_PAGE_SIZE = 100;

export interface UserListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: UserStatus;
}

const userPath = (userId: string) => `/users/${encodeURIComponent(userId)}`;

export const listUsers = (query: UserListQuery) =>
  apiRequest<{ users: User[]; total: number }>('/users', { query: { ...query } });

/** Reads every page, for summaries that have to count across all people. */
export async function listAllUsers(): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listUsers({ page, pageSize: MAX_PAGE_SIZE });
    users.push(...result.users);
    if (users.length >= result.total || result.users.length === 0) return users;
  }
}

export const getUser = (userId: string) => apiRequest<User>(userPath(userId));

export const createUser = (details: Partial<UserDetails>) =>
  apiRequest<TemporaryPasswordResult>('/users', { method: 'POST', body: details });

export const updateUser = (userId: string, details: Partial<UserDetails>) =>
  apiRequest<User>(userPath(userId), { method: 'PATCH', body: details });

export const setUserStatus = (userId: string, status: UserStatus) =>
  apiRequest<User>(`${userPath(userId)}/status`, { method: 'PATCH', body: { status } });

export const resetUserPassword = (userId: string) =>
  apiRequest<TemporaryPasswordResult>(`${userPath(userId)}/reset-password`, { method: 'POST' });

/** Replaces the permission sets a person holds in one module. Giving a new one needs a reason. */
export const setUserPermissionSets = (userId: string, moduleKey: string, permissionSets: string[], reason?: string) =>
  apiRequest<User>(`${userPath(userId)}/permission-sets`, { method: 'PUT', body: { module: moduleKey, permissionSets, reason } });

export const setUserProfile = (userId: string, profileId: string | null) =>
  apiRequest<User>(userPath(userId), { method: 'PATCH', body: { profileId } });

export async function getAccessOptions(): Promise<AccessOption[]> {
  return (await apiRequest<{ modules: AccessOption[] }>('/users/access-options')).modules;
}

/** How many matches the person search shows. Typing narrows the list if there are more. */
const ADDABLE_PEOPLE_PAGE_SIZE = 20;

export const listAddablePeople = (moduleKey: string, search: string) =>
  apiRequest<{ total: number; people: AddablePerson[] }>(`/modules/${encodeURIComponent(moduleKey)}/addable-people`, {
    query: { page: 1, pageSize: ADDABLE_PEOPLE_PAGE_SIZE, search },
  });

export async function listModulePeople(moduleKey: string): Promise<ModulePerson[]> {
  return (await apiRequest<{ people: ModulePerson[] }>(`/modules/${encodeURIComponent(moduleKey)}/people`)).people;
}
