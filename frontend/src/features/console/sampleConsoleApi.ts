import { ApiRequestError } from '@/lib/api/client';
import type {
  ActivityEntry,
  ConsoleApi,
  ConsoleUser,
  ModuleAccessOptions,
  RegisteredModule,
  RoleTemplate,
  TemporaryPasswordResult,
} from './consoleTypes';

/**
 * Stands in for the admin API until it's built, so the console screens can be reviewed. Delete this file when it is.
 * The people come from seed/users.json and the roles from the manifests. Changes last until the page reloads.
 */

const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 60 * MINUTE_IN_MS;
const DAY_IN_MS = 24 * HOUR_IN_MS;

type SamplePerson = Partial<ConsoleUser> & Pick<ConsoleUser, 'id' | 'name' | 'email' | 'title' | 'department' | 'team'>;

function samplePerson(person: SamplePerson): ConsoleUser {
  return { contract: 'permanent', status: 'active', superAdmin: false, mustChangePassword: false, assignments: {}, privileges: {}, ...person };
}

const users: ConsoleUser[] = [
  samplePerson({ id: 'u_01', name: 'Farhana Kabir', email: 'farhana@twintrack.test', title: 'Founder', department: 'operations', team: 'leadership', superAdmin: true }),
  samplePerson({ id: 'u_03', name: 'Sabbir Alam', email: 'sabbir@twintrack.test', title: 'HR Executive', department: 'people', team: 'people-ops', managerId: 'u_01', assignments: { hr: 'staff', master: 'hr-access' } }),
  samplePerson({ id: 'u_04', name: 'Rahim Uddin', email: 'rahim@twintrack.test', title: 'Engineering Lead', department: 'engineering', team: 'platform', managerId: 'u_01', assignments: { hr: 'manager', account: 'viewer' } }),
  samplePerson({ id: 'u_05', name: 'Rumana Akter', email: 'rumana@twintrack.test', title: 'Finance Lead', department: 'finance', team: 'finance', managerId: 'u_01', assignments: { account: 'admin', hr: 'viewer', master: 'auditor' } }),
  samplePerson({ id: 'u_06', name: 'Kamrul Islam', email: 'kamrul@twintrack.test', title: 'Accountant', department: 'finance', team: 'finance', managerId: 'u_05', assignments: { account: 'accountant' } }),
  samplePerson({ id: 'u_07', name: 'Arif Chowdhury', email: 'arif@twintrack.test', title: 'Frontend Developer', department: 'engineering', team: 'platform', managerId: 'u_04' }),
  samplePerson({ id: 'u_08', name: 'Karim Ahmed', email: 'karim@twintrack.test', title: 'Backend Developer', department: 'engineering', team: 'platform', managerId: 'u_04' }),
  samplePerson({ id: 'u_09', name: 'Mehedi Hasan', email: 'mehedi@twintrack.test', title: 'Engineering Intern', department: 'engineering', team: 'platform', contract: 'intern', managerId: 'u_04' }),
  samplePerson({ id: 'u_10', name: 'Sumaiya Islam', email: 'sumaiya@twintrack.test', title: 'UI Designer (agency)', department: 'design', team: 'platform', contract: 'contractor', managerId: 'u_04' }),
  samplePerson({ id: 'u_11', name: 'Jahid Rana', email: 'jahid@twintrack.test', title: 'Support Agent (left)', department: 'operations', team: 'support', status: 'inactive', managerId: 'u_01' }),
];

const accessOptions: ModuleAccessOptions[] = [
  {
    key: 'master',
    name: 'Master',
    roles: [
      { key: 'admin', name: 'Access Admin' },
      { key: 'hr-access', name: 'HR access manager' },
      { key: 'employee-access', name: 'Employee access manager' },
      { key: 'auditor', name: 'Auditor' },
    ],
    grantable: [],
  },
  {
    key: 'hr',
    name: 'HR',
    roles: [
      { key: 'admin', name: 'HR Admin' },
      { key: 'manager', name: 'Manager' },
      { key: 'staff', name: 'HR Staff' },
      { key: 'viewer', name: 'Viewer' },
    ],
    grantable: [
      { permission: 'salary.read', scope: 'all' },
      { permission: 'leave.read', scope: 'team' },
      { permission: 'leave.approve', scope: 'team' },
      { permission: 'recruitment.read', scope: 'all' },
    ],
  },
];

const EVERYTHING = ['Everything in this module'];
const roles: RoleTemplate[] = [
  { module: 'master', moduleName: 'Master', key: 'admin', name: 'Access Admin', description: 'Manages people, roles and modules.', grants: EVERYTHING },
  { module: 'master', moduleName: 'Master', key: 'hr-access', name: 'HR access manager', description: "HR staff who set each person's HR role and special privileges. Cannot change role templates.", grants: ['user.read', 'hrAccess.read', 'hrAccess.update', 'employeeAccess.read', 'employeeAccess.update', 'fieldAccess.read', 'fieldAccess.update'] },
  { module: 'master', moduleName: 'Master', key: 'employee-access', name: 'Employee access manager', description: 'Sets who has which Employee app role and manages HR-managed fields. Cannot change collection permissions.', grants: ['user.read', 'employeeAccess.read', 'employeeAccess.update', 'fieldAccess.read', 'fieldAccess.update'] },
  { module: 'master', moduleName: 'Master', key: 'auditor', name: 'Auditor', description: 'Reads the activity log and who has Employee app access.', grants: ['audit.read', 'user.read', 'hrAccess.read', 'employeeAccess.read', 'fieldAccess.read'] },
  { module: 'hr', moduleName: 'HR', key: 'admin', name: 'HR Admin', description: 'Full control of HR.', grants: EVERYTHING },
  { module: 'hr', moduleName: 'HR', key: 'manager', name: 'Manager', description: 'Sees their team and approves their leave.', grants: ['employee.read (team)', 'leave.read (team)', 'leave.approve (team)', 'attendance.read (team)'] },
  { module: 'hr', moduleName: 'HR', key: 'staff', name: 'HR Staff', description: 'Keeps records and attendance up to date.', grants: ['employee.read', 'employee.create', 'employee.update', 'leave.read', 'leave.create', 'attendance.read', 'attendance.update', 'recruitment.read', 'recruitment.create', 'recruitment.update'] },
  { module: 'hr', moduleName: 'HR', key: 'viewer', name: 'Viewer', description: 'Read-only view of employee records.', grants: ['employee.read'] },
];

let modules: RegisteredModule[] = [
  { key: 'master', name: 'Master', version: '1.4.0', description: 'Login, users, permissions and the API behind every module.', core: true, frontendUrl: 'http://twintrack.localhost:3100' },
  { key: 'hr', name: 'HR', version: '1.3.0', description: 'Employee records, leave, attendance and hiring.', core: false, frontendUrl: 'http://hr.twintrack.localhost:3200' },
];

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_IN_MS).toISOString();
}

let nextEntryNumber = 1;
const entryId = () => `sample_${nextEntryNumber++}`;

const activity: ActivityEntry[] = [
  { id: entryId(), at: hoursAgo(0.2), actorName: 'Farhana Kabir', action: 'auth.login', ip: '103.44.12.8' },
  { id: entryId(), at: hoursAgo(1), actorName: 'Sabbir Alam', action: 'user.role_changed', targetName: 'Rahim Uddin', module: 'hr', ip: '103.44.12.9' },
  { id: entryId(), at: hoursAgo(2.5), actorName: 'Karim Ahmed', action: 'auth.login_failed', ip: '45.64.20.3' },
  { id: entryId(), at: hoursAgo(4), actorName: 'Rumana Akter', action: 'auth.password_changed', ip: '182.16.8.2' },
  { id: entryId(), at: hoursAgo(26), actorName: 'Sabbir Alam', action: 'user.privileges_changed', targetName: 'Karim Ahmed', module: 'hr', ip: '103.44.12.9' },
  { id: entryId(), at: hoursAgo(31), actorName: 'Rahim Uddin', action: 'auth.session_token_reused', ip: '182.16.8.40' },
  { id: entryId(), at: new Date(Date.now() - 3 * DAY_IN_MS).toISOString(), actorName: 'Farhana Kabir', action: 'user.deactivated', targetName: 'Jahid Rana', ip: '103.44.12.8' },
  { id: entryId(), at: new Date(Date.now() - 4 * DAY_IN_MS).toISOString(), actorName: 'Farhana Kabir', action: 'module.imported', targetName: 'HR', ip: '103.44.12.8' },
];

// The console has no real session behind these changes, so the log names a stand-in.
function recordActivity(action: string, targetName: string, module?: string): void {
  activity.unshift({ id: entryId(), at: new Date().toISOString(), actorName: 'You (sample)', action, targetName, module });
}

function findUser(id: string): ConsoleUser {
  const user = users.find((candidate) => candidate.id === id);
  if (!user) throw new ApiRequestError(404, 'unknown_user', 'No such user.');
  return user;
}

function createTemporaryPassword(): string {
  return `sample-${crypto.randomUUID().slice(0, 13)}`;
}

function paginate<Item>(items: Item[], page: number, pageSize: number): Item[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

function refuseTakenEmail(email: string, ownId?: string): void {
  const isTaken = users.some((user) => user.email === email && user.id !== ownId);
  if (isTaken) throw new ApiRequestError(409, 'email_taken', 'Someone already uses that email address.');
}

export const sampleConsoleApi: ConsoleApi = {
  async listUsers({ page, pageSize, search, status }) {
    const searchText = search?.trim().toLowerCase() ?? '';
    const matching = users.filter(
      (user) =>
        (!status || user.status === status) &&
        (!searchText || user.name.toLowerCase().includes(searchText) || user.email.includes(searchText) || user.title?.toLowerCase().includes(searchText)),
    );
    return { users: paginate(matching, page, pageSize), total: matching.length };
  },

  getUser: async (id) => findUser(id),

  async createUser(details) {
    refuseTakenEmail(details.email);
    const user = samplePerson({ ...details, id: `u_sample_${users.length + 1}`, title: details.title, department: details.department, team: details.team, mustChangePassword: true });
    users.push(user);
    recordActivity('user.created', user.name);
    return { user, temporaryPassword: createTemporaryPassword() };
  },

  async updateUser(id, details) {
    refuseTakenEmail(details.email, id);
    const user = Object.assign(findUser(id), details);
    recordActivity('user.updated', user.name);
    return user;
  },

  async setUserStatus(id, status) {
    const user = findUser(id);
    user.status = status;
    recordActivity(status === 'active' ? 'user.reactivated' : 'user.deactivated', user.name);
    return user;
  },

  async resetUserPassword(id): Promise<TemporaryPasswordResult> {
    const user = findUser(id);
    user.mustChangePassword = true;
    recordActivity('user.password_reset', user.name);
    return { user, temporaryPassword: createTemporaryPassword() };
  },

  listAccessOptions: async () => accessOptions,

  async setUserRole(id, moduleKey, roleKey) {
    const user = findUser(id);
    if (roleKey) user.assignments[moduleKey] = roleKey;
    else delete user.assignments[moduleKey];
    recordActivity('user.role_changed', user.name, moduleKey);
    return user;
  },

  async setUserPrivileges(id, moduleKey, permissions) {
    const user = findUser(id);
    user.privileges[moduleKey] = permissions;
    recordActivity('user.privileges_changed', user.name, moduleKey);
    return user;
  },

  listRoles: async () => roles,
  listModules: async () => modules,

  async importModule(manifest) {
    const { module: details } = manifest as { module?: Partial<RegisteredModule> };
    if (!details?.key || !details.name || !details.version) {
      throw new ApiRequestError(422, 'invalid_manifest', 'That file is not a valid module manifest.');
    }
    const imported: RegisteredModule = { key: details.key, name: details.name, version: details.version, description: details.description, core: false, frontendUrl: null };
    modules = [...modules.filter((module) => module.key !== imported.key), imported];
    recordActivity('module.imported', imported.name);
    return imported;
  },

  async removeModule(key) {
    const removed = modules.find((module) => module.key === key);
    if (removed?.core) throw new ApiRequestError(409, 'core_module', 'A core module cannot be removed.');
    modules = modules.filter((module) => module.key !== key);
    if (removed) recordActivity('module.removed', removed.name);
  },

  async listActivity({ page, pageSize, actionPrefix }) {
    const matching = activity.filter((entry) => !actionPrefix || entry.action.startsWith(actionPrefix));
    return { entries: paginate(matching, page, pageSize), total: matching.length };
  },
};
