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
  /** True when the module takes a one-time sign-in code, so the portal opens it through /open/<key>. */
  signsInWithCode: boolean;
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
  /** For each of those APIs, what it is for and sample requests, keyed like apis' values. */
  guides: Record<string, ApiGuide>;
  /** Super admins only: records an id field can be chosen from, by kind of record, such as User. */
  references?: Record<string, ReferenceOption[]>;
}

export interface BodyFieldOption {
  field: string;
  values: (string | number | boolean | null)[];
  /** The field holds a list of these values. */
  isMany: boolean;
}

export interface ReferenceOption {
  id: string;
  label: string;
}

/** A body field or path parameter that takes a record's id, and the list in references to choose it from. */
export interface ReferenceChoice {
  field: string;
  location: 'body' | 'path';
  list: string;
  isMany: boolean;
}

/** A sample request for one API, taken from the scenarios the API's tests replay. */
export interface ApiExample {
  title: string;
  /** Super admins only: the fields that take a record's id. */
  choices?: ReferenceChoice[];
  outcome: 'accepted' | 'refused';
  expectedStatus: number;
  expectedCode?: string;
  /** Who sends it in the example data. The answer depends on their access, which may differ from yours. */
  sentBy?: string;
  /** Requests the example data sends first, as "METHOD /path". */
  sendFirst: string[];
  /** Path parameter values. An empty one comes from an earlier request, named in needs. */
  parameters: Record<string, string>;
  /** For an empty parameter, the value from an earlier step it takes. */
  parameterSources: Record<string, string>;
  query: string;
  body: string;
  needs: { value: string; madeBy: string }[];
  changesData: boolean;
}

export interface ApiGuide {
  purpose?: string;
  input?: string;
  examples: ApiExample[];
  /** Body fields that take one of a fixed set of values, such as a status. */
  fieldOptions?: BodyFieldOption[];
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

/** Whose token or connected app it is, on the admin screen. */
export interface TokenOwner {
  id: string;
  name: string;
}

export type OwnedApiToken = ApiToken & { owner: TokenOwner };
export type OwnedConnectedApp = ConnectedApp & { owner: TokenOwner };

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

/** Someone who holds a profile, from GET /access-profiles/:id/people. */
export interface ProfileHolder {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  orgRole: { id: string; name: string } | null;
  /** Whether the viewer may take the profile away from them. The API refuses anyone else. */
  canRemove: boolean;
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
  /** Names to show for fields whose key doesn't say what they hold, such as lines: "Salary per person". */
  fieldLabels?: Record<string, string>;
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

/** Where a module's frontend lives and what may sign in to it. Only a super admin changes it. */
export interface FrontendSettings {
  frontendUrl: string | null;
  /** `app` when saved on the Modules screen, `environment` when from MODULE_FRONTEND_URLS. */
  frontendUrlSource: 'app' | 'environment' | null;
  redirectUrls: string[];
  allowedOrigins: string[];
  changedAt: string | null;
}

export interface RegisteredModule {
  key: string;
  name: string;
  version: string;
  description?: string;
  core: boolean;
  frontendUrl: string | null;
  frontendSettings: FrontendSettings;
  resources: ModuleResource[];
  /** The records its API returns, as JSON Schema. Empty `$defs` until a schema is loaded. */
  schema: ModuleSchema;
  /** Each permission and the APIs it opens, as "METHOD /path". */
  apis: Record<string, string[]>;
  /** Every built API, with who may call it. */
  routes: ModuleApiRoute[];
  /** Each permission and the APIs and profiles that rely on it. An action in use can't be removed. */
  usedBy: Record<string, string[]>;
}

/** A JSON Schema property, as far as the Modules screen reads it. */
export interface SchemaProperty {
  type?: string | string[];
  $ref?: string;
  enum?: unknown[];
  format?: string;
  items?: SchemaProperty;
  description?: string;
  /** Field security: `controlled` or `protected`. */
  'x-fieldAccess'?: string;
}

export interface SchemaDefinition extends SchemaProperty {
  required?: string[];
  properties?: Record<string, SchemaProperty>;
  allOf?: SchemaProperty[];
}

export interface ModuleSchema {
  $schema?: string;
  title?: string;
  description?: string;
  $defs: Record<string, SchemaDefinition>;
}

/** public: anyone, without signing in. signed: any signed-in person. private: needs a permission from their profile. */
export type ApiAccessRule = 'public' | 'signed' | 'private';

export interface ModuleApiRoute {
  method: string;
  path: string;
  /** The rule in force, after any change a super admin made. */
  access: ApiAccessRule;
  /** Any one of these opens it. Empty unless private. */
  permissions: string[];
  /** The rule it was built with, in its code and manifest. */
  declaredAccess: ApiAccessRule;
  declaredPermissions: string[];
  isChanged: boolean;
  /** The rules a super admin may give it. Only one means it can't be changed. */
  allowedAccess: ApiAccessRule[];
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
