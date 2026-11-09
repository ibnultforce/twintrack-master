export type Scope = 'own' | 'team' | 'all';
export type PermissionMap = Record<string, Scope>;
export type Contract = 'permanent' | 'intern' | 'contractor';
export type UserStatus = 'active' | 'inactive';

export interface Profile {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: Contract;
  superAdmin: boolean;
  mustChangePassword: boolean;
  manager: { id: string; name: string } | null;
}

export interface MyModule {
  key: string;
  name: string;
  description?: string;
  frontendUrl: string | null;
  roleName: string | null;
}

export interface ModuleAccess {
  module: string;
  hasAccess: boolean;
  role: string | null;
  roleName: string | null;
  permissions: PermissionMap;
  specialPrivileges: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  contract: Contract;
  status: UserStatus;
  managerId?: string;
  superAdmin: boolean;
  mustChangePassword: boolean;
  assignments: Record<string, string>;
  privileges: Record<string, string[]>;
  superAdminGrants: Record<string, string[]>;
}

export interface UserDetails {
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  team: string | null;
  contract: Contract;
  managerId: string | null;
}

export interface TemporaryPasswordResult {
  user: User;
  temporaryPassword: string;
}

export interface GrantablePermission {
  permission: string;
  scope: Scope;
}

export interface AccessOption {
  key: string;
  name: string;
  roles: { key: string; name: string }[];
  grantable: GrantablePermission[];
  canChange: boolean;
}

export interface ModulePerson {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  role: string | null;
  privileges: string[];
  superAdminGrants: string[];
}

export interface AddablePerson {
  id: string;
  name: string;
  email: string;
  title?: string;
}

export type ResourceAction = 'read' | 'create' | 'update' | 'delete' | 'approve';

export interface ModuleResource {
  key: string;
  label: string;
  actions: ResourceAction[];
  scoped?: boolean;
  grantable?: ResourceAction[];
}

export interface RegisteredModule {
  key: string;
  name: string;
  version: string;
  description?: string;
  core: boolean;
  frontendUrl: string | null;
  resources: ModuleResource[];
  /** Each permission and the APIs it opens, as "METHOD /path". */
  apis: Record<string, string[]>;
}

export interface ManageableModule {
  key: string;
  name: string;
  resources: ModuleResource[];
  apis: Record<string, string[]>;
  /** What this person may put in a role, and how far it can reach. */
  assignable: PermissionMap;
  roles: RoleTemplate[];
}

export interface RoleTemplate {
  module: string;
  moduleName: string;
  key: string;
  name: string;
  description: string;
  grants: string[];
  permissions: PermissionMap;
}

export type RoleGrants = Record<string, { actions: ResourceAction[]; scope?: Scope }>;

export interface AuditEntry {
  id: string;
  at: string;
  actorId?: string;
  actorName?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  module?: string;
  reason?: string;
}
