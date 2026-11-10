export type Scope = 'own' | 'team' | 'all';
export type PermissionMap = Record<string, Scope>;
export type FieldAccessLevel = 'read' | 'edit';
/** Access to protected fields, as "resource.field" to read or edit. */
export type FieldAccessMap = Record<string, FieldAccessLevel>;
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
  orgRoleId?: string;
  manager: { id: string; name: string } | null;
}

export interface MyModule {
  key: string;
  name: string;
  description?: string;
  frontendUrl: string | null;
  profileName: string | null;
  permissionSets: string[];
}

export interface ModuleAccess {
  module: string;
  hasAccess: boolean;
  profile: string | null;
  profileName: string | null;
  permissions: PermissionMap;
  /** The keys of the permission sets that count in this module. */
  permissionSets: string[];
  fieldAccess: FieldAccessMap;
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
  orgRoleId?: string;
  profileId?: string;
  superAdmin: boolean;
  mustChangePassword: boolean;
  /** Module key to the keys of the permission sets held there. */
  permissionSets: Record<string, string[]>;
}

export interface UserDetails {
  name: string;
  email: string;
  title: string | null;
  department: string | null;
  team: string | null;
  contract: Contract;
  managerId: string | null;
  orgRoleId: string;
  profileId?: string | null;
}

export interface TemporaryPasswordResult {
  user: User;
  temporaryPassword: string;
}

export interface PermissionSetSummary {
  key: string;
  name: string;
  description: string;
  /** Short labels, such as "salary.read (team)". */
  grants: string[];
  permissions: PermissionMap;
  fieldAccess: FieldAccessMap;
}

export interface AccessOption {
  key: string;
  name: string;
  permissionSets: PermissionSetSummary[];
  canChange: boolean;
}

export interface ModulePerson {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  profile: { id: string; name: string } | null;
  /** What the person's profile gives in this module. */
  profilePermissions: PermissionMap;
  permissionSets: string[];
}

export interface AddablePerson {
  id: string;
  name: string;
  email: string;
  title?: string;
}

export type ResourceAction = 'read' | 'create' | 'update' | 'delete' | 'approve' | 'share';

export interface ModuleResource {
  key: string;
  label: string;
  actions: ResourceAction[];
  scoped?: boolean;
  /** Fields hidden unless a profile or permission set gives read or edit access to them. */
  protectedFields?: string[];
  /** Set on objects an admin defined in the app. */
  custom?: boolean;
  fields?: CustomFieldDefinition[];
  sharingModel?: 'private' | 'publicRead' | 'publicReadWrite';
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface CustomFieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  options?: string[];
  tracked?: boolean;
  protected?: boolean;
}

/** A custom object this person can read, with the fields they may see. */
export interface ReadableObject {
  module: string;
  moduleName: string;
  key: string;
  label: string;
  fields: (CustomFieldDefinition & { editable: boolean })[];
  can: { create: boolean; update: boolean; delete: boolean };
}

export interface CustomRecordView {
  id: string;
  ownerId: string;
  values: Record<string, unknown>;
  version: number;
  createdBy?: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface HistoryEntry {
  id: string;
  at: string;
  action: 'created' | 'updated' | 'deleted' | 'restored';
  changes: { field: string; from?: unknown; to?: unknown }[];
  actorName: string;
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
  /** Each permission and the APIs, permission sets and profiles that rely on it. An action in use can't be removed. */
  usedBy: Record<string, string[]>;
}

export interface PermissionSetRights {
  create: boolean;
  update: boolean;
  delete: boolean;
}

export interface ManageableModule {
  key: string;
  name: string;
  resources: ModuleResource[];
  apis: Record<string, string[]>;
  can: PermissionSetRights;
  /** What this person may put in a permission set, and how far it can reach. */
  assignable: PermissionMap;
  /** The protected fields this person may give access to. */
  assignableFields: FieldAccessMap;
  permissionSets: PermissionSet[];
}

export interface PermissionSet {
  module: string;
  moduleName: string;
  key: string;
  name: string;
  description: string;
  grants: string[];
  permissions: PermissionMap;
  fieldAccess: FieldAccessMap;
}

/** Grants for one module, as the API takes them. A profile or set may also hold "*", everything in the module. */
export type Grants = Record<string, { actions: ResourceAction[]; scope?: Scope; fieldAccess?: Record<string, FieldAccessLevel> }>;

export interface AccessProfile {
  id: string;
  name: string;
  description: string;
  grants: Record<string, Grants | '*'>;
  holders: number;
  modules: { key: string; name: string; loaded: boolean; grants: string[]; permissions: PermissionMap; fieldAccess: FieldAccessMap }[];
}

export interface OrgRole {
  id: string;
  name: string;
  description?: string;
  parentId: string | null;
  depth: number;
  peopleCount: number;
  createdAt: string;
  updatedAt: string;
}

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
