/**
 * What the console screens need from the admin API.
 * The admin routes aren't built yet, so these shapes are a best guess, and only this file,
 * liveConsoleApi.ts and sampleConsoleApi.ts should need changing once they are.
 */

export type UserStatus = 'active' | 'inactive';
export type ContractType = 'permanent' | 'intern' | 'contractor';

export interface ConsoleUser {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: ContractType;
  status: UserStatus;
  managerId?: string;
  superAdmin: boolean;
  mustChangePassword: boolean;
  /** Module key to role key, for example { hr: 'manager' }. */
  assignments: Record<string, string>;
  /** Module key to extra permissions, for example { hr: ['salary.read'] }. */
  privileges: Record<string, string[]>;
}

export interface UserListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: UserStatus;
}

export interface UserPage {
  users: ConsoleUser[];
  total: number;
}

export interface UserDetailsInput {
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: ContractType;
}

/** The only time a temporary password is available. It can't be read again afterwards. */
export interface TemporaryPasswordResult {
  user: ConsoleUser;
  temporaryPassword: string;
}

/** Which roles and special privileges can be given in one module. */
export interface ModuleAccessOptions {
  key: string;
  name: string;
  roles: { key: string; name: string }[];
  grantable: { permission: string; scope: 'team' | 'all' }[];
}

export interface RoleTemplate {
  module: string;
  moduleName: string;
  key: string;
  name: string;
  description: string;
  /** For example "employee.read (team)", or "Everything in this module". */
  grants: string[];
}

export interface RegisteredModule {
  key: string;
  name: string;
  version: string;
  description?: string;
  /** A core module can't be removed. */
  core: boolean;
  frontendUrl: string | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  actorName?: string;
  /** A code such as "auth.login". activityLabels.ts turns it into words. */
  action: string;
  targetName?: string;
  module?: string;
  reason?: string;
  ip?: string;
}

export interface ActivityQuery {
  page: number;
  pageSize: number;
  /** Only actions starting with this, such as "auth." */
  actionPrefix?: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  total: number;
}

export interface ConsoleApi {
  listUsers(query: UserListQuery): Promise<UserPage>;
  getUser(id: string): Promise<ConsoleUser>;
  createUser(details: UserDetailsInput): Promise<TemporaryPasswordResult>;
  updateUser(id: string, details: UserDetailsInput): Promise<ConsoleUser>;
  setUserStatus(id: string, status: UserStatus): Promise<ConsoleUser>;
  resetUserPassword(id: string): Promise<TemporaryPasswordResult>;
  listAccessOptions(): Promise<ModuleAccessOptions[]>;
  setUserRole(id: string, moduleKey: string, roleKey: string | null): Promise<ConsoleUser>;
  setUserPrivileges(id: string, moduleKey: string, permissions: string[]): Promise<ConsoleUser>;
  listRoles(): Promise<RoleTemplate[]>;
  listModules(): Promise<RegisteredModule[]>;
  importModule(manifest: unknown): Promise<RegisteredModule>;
  removeModule(key: string): Promise<void>;
  listActivity(query: ActivityQuery): Promise<ActivityPage>;
}
