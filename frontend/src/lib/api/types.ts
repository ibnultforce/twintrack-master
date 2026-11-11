export type Scope = 'own' | 'team' | 'all';
export type PermissionMap = Record<string, Scope>;
/** Narrowest first, matching the backend's order. */
export const FIELD_ACCESS_LEVELS = ['hidden', 'read', 'create', 'edit'] as const;
export type FieldAccessLevel = (typeof FIELD_ACCESS_LEVELS)[number];
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
  orgRoleId?: string;
  manager: { id: string; name: string } | null;
  employeeNumber?: number;
  photoUpdatedAt?: string;
  /** The super admin seeing the app as this person, when that is what this session is. */
  impersonatedBy?: { id: string; name: string };
  /** Whether "Log in as" is offered: a super admin, in development, not already signed in as someone else. */
  canImpersonate: boolean;
}

export interface MyModule {
  key: string;
  name: string;
  description?: string;
  frontendUrl: string | null;
  profileName: string | null;
}

export interface ModuleAccess {
  module: string;
  hasAccess: boolean;
  profile: string | null;
  profileName: string | null;
  permissions: PermissionMap;
  fieldAccess: FieldAccessMap;
  /** Each permission held and the APIs it opens, as "METHOD /path". */
  apis: Record<string, string[]>;
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
  employeeNumber?: number;
  /** When the photo last changed. Missing means there's no photo. */
  photoUpdatedAt?: string;
  /** Missing means they have never signed in, so their account is still waiting to be set up. */
  lastSignedInAt?: string;
  /** Missing when the viewer may not see this person's online status. */
  online?: boolean;
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
  /** Handed out in order when a person is added, so only an edit sets it. */
  employeeNumber?: number;
}

export interface CreatedUserResult {
  user: User;
  /** False when the invitation email couldn't be sent. A new link can be sent from the person's page. */
  invitationSent: boolean;
}

export type PasswordLinkError = 'unknown_user' | 'account_inactive' | 'super_admin_protected' | 'own_account' | 'email_failed';

export interface PasswordLinkResult {
  userId: string;
  email?: string;
  sent: boolean;
  error?: PasswordLinkError;
}

/** What anyone signed in may see about a colleague. */
export interface DirectoryEntry {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  employeeNumber?: number;
  photoUpdatedAt?: string;
  online?: boolean;
}

export type ClientStatus = 'active' | 'inactive';

export interface Client {
  id: string;
  name: string;
  initials?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes?: string;
  status: ClientStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClientDetails {
  name: string;
  initials: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  notes: string | null;
}

export interface ApiToken {
  id: string;
  name: string;
  /** The token's first characters, to tell tokens apart. */
  prefix: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface ConnectedApp {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** An app asking to connect, as the consent page shows it. */
export interface OAuthRequest {
  id: string;
  clientName: string;
  /** Where the browser goes back to, which the app can't fake, unlike its name. */
  redirectHost: string;
  expiresAt: string;
}

/** A loaded module, as the Access screen lists them. */
export interface AccessModule {
  key: string;
  name: string;
}

export interface ModulePerson {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  /** Their place in the org tree, which decides whose records their team scope reaches. */
  orgRole: { id: string; name: string } | null;
  profile: { id: string; name: string } | null;
  /** What the person's profile gives in this module. */
  profilePermissions: PermissionMap;
}

export interface AddablePerson {
  id: string;
  name: string;
  email: string;
  title?: string;
  /** The profile they hold now, which giving one replaces. */
  profileId?: string;
}

export type ResourceAction = 'read' | 'create' | 'update' | 'delete' | 'approve' | 'share';

export interface ModuleResource {
  key: string;
  label: string;
  actions: ResourceAction[];
  scoped?: boolean;
  /** The record's fields that field access controls. */
  recordFields?: string[];
  /** Fields hidden unless a profile gives access to them. */
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
  fields: (CustomFieldDefinition & { editable: boolean; creatable: boolean })[];
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
  /** Each permission and the APIs and profiles that rely on it. An action in use can't be removed. */
  usedBy: Record<string, string[]>;
}

/** Grants for one module, as the API takes them. A profile may also hold "*", everything in the module. */
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
