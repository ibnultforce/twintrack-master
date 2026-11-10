import { describe, expect, it } from 'vitest';
import { resolveModuleAccess, type Grantee } from '../src/modules/master/access/permissions.js';
import type { Grants, ManifestPermissionSet, ManifestResource } from '../src/modules/master/moduleRegistry/manifest.js';

const resources: ManifestResource[] = [
  { key: 'employee', label: 'Employees', actions: ['read', 'update'], scoped: true },
  { key: 'salary', label: 'Salaries', actions: ['read', 'update'] },
  { key: 'leave', label: 'Leave', actions: ['read', 'approve'], scoped: true },
];

const permissionSets: ManifestPermissionSet[] = [
  { key: 'admin', name: 'Admin', grants: '*' },
  { key: 'manager', name: 'Manager', grants: { employee: { actions: ['read'], scope: 'team' }, leave: { actions: ['read'], scope: 'all' } } },
  { key: 'careless', name: 'No scope stated', grants: { employee: { actions: ['read'] }, salary: { actions: ['read'] } } },
  { key: 'leave-approver', name: 'Leave approver', grants: { leave: { actions: ['approve'], scope: 'team' } } },
];

const hrModule = { key: 'hr', resources, permissionSets };

const person = ({
  superAdmin = false,
  sets = {},
  profileGrants,
}: { superAdmin?: boolean; sets?: Record<string, string[]>; profileGrants?: Record<string, Grants> } = {}): Grantee => ({
  user: { superAdmin, permissionSets: sets },
  profile: profileGrants ? { _id: 'ap_staff', name: 'Staff', grants: profileGrants } : null,
});

describe('resolveModuleAccess', () => {
  it('gives nothing to someone with no profile or permission set', () => {
    expect(resolveModuleAccess(person(), hrModule)).toEqual({
      hasAccess: false,
      profile: null,
      profileName: null,
      permissions: {},
      permissionSets: [],
      fieldAccess: {},
    });
  });

  it('applies the actions and scopes of a profile part for the module', () => {
    const access = resolveModuleAccess(person({ profileGrants: { hr: { employee: { actions: ['read'], scope: 'team' } } } }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, profile: 'ap_staff', profileName: 'Staff', permissionSets: [] });
    expect(access.permissions).toEqual({ 'employee.read': 'team' });
  });

  it('gives nothing from a profile that has no part for this module', () => {
    expect(resolveModuleAccess(person({ profileGrants: { project: '*' } }), hrModule).hasAccess).toBe(false);
  });

  it('applies the actions and scopes of a permission set', () => {
    const access = resolveModuleAccess(person({ sets: { hr: ['manager'] } }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, profile: null, permissionSets: ['manager'] });
    expect(access.permissions).toEqual({ 'employee.read': 'team', 'leave.read': 'all' });
  });

  it('gives a wildcard every action, across all data', () => {
    const { permissions } = resolveModuleAccess(person({ sets: { hr: ['admin'] } }), hrModule);
    expect(Object.keys(permissions)).toHaveLength(6);
    expect(new Set(Object.values(permissions))).toEqual(new Set(['all']));
  });

  it('gives a super admin everything without a profile', () => {
    const access = resolveModuleAccess(person({ superAdmin: true }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, profile: 'super-admin', profileName: 'Super admin' });
    expect(access.permissions['salary.update']).toBe('all');
  });

  it('grants nothing from a set the module no longer has, or a set in another module', () => {
    expect(resolveModuleAccess(person({ sets: { hr: ['removed-set'] } }), hrModule)).toMatchObject({ hasAccess: false, permissionSets: [] });
    expect(resolveModuleAccess(person({ sets: { account: ['admin'] } }), hrModule).hasAccess).toBe(false);
  });

  it('uses the narrowest scope when a scoped resource states none, and all for an unscoped one', () => {
    const { permissions } = resolveModuleAccess(person({ sets: { hr: ['careless'] } }), hrModule);
    expect(permissions).toEqual({ 'employee.read': 'own', 'salary.read': 'all' });
  });

  it('adds permission sets to the profile, keeping the wider scope where they overlap', () => {
    const access = resolveModuleAccess(
      person({ profileGrants: { hr: { leave: { actions: ['read'], scope: 'own' } } }, sets: { hr: ['manager', 'leave-approver'] } }),
      hrModule,
    );
    expect(access.permissions).toEqual({ 'employee.read': 'team', 'leave.read': 'all', 'leave.approve': 'team' });
    expect(access.permissionSets).toEqual(['manager', 'leave-approver']);
  });

  it('ignores grants for resources or actions the module does not have', () => {
    const access = resolveModuleAccess(person({ profileGrants: { hr: { ghost: { actions: ['read'] }, salary: { actions: ['approve'] } } } }), hrModule);
    expect(access.hasAccess).toBe(false);
    expect(access.permissions).toEqual({});
  });
});
