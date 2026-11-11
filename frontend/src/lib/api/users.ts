import { apiBlob, apiRequest, setAccessToken } from './http';
import type { AccessModule, AddablePerson, CreatedUserResult, ModulePerson, PasswordLinkResult, User, UserDetails, UserStatus } from './types';

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

/** Adds a person, who is emailed a link to set their password. */
export const createUser = (details: Partial<UserDetails>) =>
  apiRequest<CreatedUserResult>('/users', { method: 'POST', body: details });

export const updateUser = (userId: string, details: Partial<UserDetails>) =>
  apiRequest<User>(userPath(userId), { method: 'PATCH', body: details });

export const setUserStatus = (userId: string, status: UserStatus) =>
  apiRequest<User>(`${userPath(userId)}/status`, { method: 'PATCH', body: { status } });

/** Only works for someone who never signed in. Everyone else is deactivated instead. */
export const deleteUser = (userId: string) => apiRequest(userPath(userId), { method: 'DELETE' });

export const getNextEmployeeNumber = async () =>
  (await apiRequest<{ employeeNumber: number }>('/users/next-employee-number')).employeeNumber;

/** Emails each person a one-time link to set a new password, and reports what happened for each. */
export async function sendPasswordLinks(userIds: string[]): Promise<PasswordLinkResult[]> {
  return (await apiRequest<{ results: PasswordLinkResult[] }>('/users/password-links', { method: 'POST', body: { userIds } })).results;
}

export const getUserPhoto = (userId: string) => apiBlob(`${userPath(userId)}/photo`);

export const setUserPhoto = (userId: string, image: File) =>
  apiRequest<{ photoUpdatedAt: string }>(`${userPath(userId)}/photo`, { method: 'PUT', file: image });

export const removeUserPhoto = (userId: string) => apiRequest(`${userPath(userId)}/photo`, { method: 'DELETE' });

/** Development only: signs the super admin in as this person, until they stop. */
export async function impersonateUser(userId: string): Promise<void> {
  const { accessToken } = await apiRequest<{ accessToken: string }>(`${userPath(userId)}/impersonate`, { method: 'POST' });
  setAccessToken(accessToken);
}

/** Gives a person a profile, replacing any they had, or takes it away with null. */
export const setUserProfile = (userId: string, profileId: string | null) =>
  apiRequest<User>(`${userPath(userId)}/profile`, { method: 'PUT', body: { profileId } });

/** The loaded modules, for the Access screen. Needs user.read or userProfile.update. */
export async function listAccessModules(): Promise<AccessModule[]> {
  return (await apiRequest<{ modules: AccessModule[] }>('/users/access-options')).modules;
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
