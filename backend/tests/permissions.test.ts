import { describe, expect, it } from 'vitest';
import { resolveModuleAccess, type Grantee } from '../src/modules/master/access/permissions.js';
import type { Grants, ManifestResource } from '../src/modules/master/moduleRegistry/manifest.js';

const resources: ManifestResource[] = [
  { key: 'employee', label: 'Employees', actions: ['read', 'update'], scoped: true },
  { key: 'salary', label: 'Salaries', actions: ['read', 'update'] },
  { key: 'leave', label: 'Leave', actions: ['read', 'approve'], scoped: true },
];

const hrModule = { key: 'hr', resources };

const person = ({ superAdmin = false, profileGrants }: { superAdmin?: boolean; profileGrants?: Record<string, Grants> } = {}): Grantee => ({
  user: { superAdmin },
  profile: profileGrants ? { _id: 'ap_staff', name: 'Staff', grants: profileGrants } : null,
});

describe('resolveModuleAccess', () => {
  it('gives nothing to someone with no profile', () => {
    expect(resolveModuleAccess(person(), hrModule)).toEqual({
      hasAccess: false,
      profile: null,
      profileName: null,
      permissions: {},
      fieldAccess: {},
    });
  });

  it('applies the actions and scopes of a profile part for the module', () => {
    const access = resolveModuleAccess(
      person({ profileGrants: { hr: { employee: { actions: ['read'], scope: 'team' }, leave: { actions: ['read', 'approve'], scope: 'all' } } } }),
      hrModule,
    );
    expect(access).toMatchObject({ hasAccess: true, profile: 'ap_staff', profileName: 'Staff' });
    expect(access.permissions).toEqual({ 'employee.read': 'team', 'leave.read': 'all', 'leave.approve': 'all' });
  });

  it('gives nothing from a profile that has no part for this module', () => {
    expect(resolveModuleAccess(person({ profileGrants: { project: '*' } }), hrModule).hasAccess).toBe(false);
  });

  it('gives a wildcard every action, across all data', () => {
    const { permissions } = resolveModuleAccess(person({ profileGrants: { hr: '*' } }), hrModule);
    expect(Object.keys(permissions)).toHaveLength(6);
    expect(new Set(Object.values(permissions))).toEqual(new Set(['all']));
  });

  it('gives a super admin everything without a profile', () => {
    const access = resolveModuleAccess(person({ superAdmin: true }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, profile: 'super-admin', profileName: 'Super admin' });
    expect(access.permissions['salary.update']).toBe('all');
  });

  it('uses the narrowest scope when a scoped resource states none, and all for an unscoped one', () => {
    const { permissions } = resolveModuleAccess(person({ profileGrants: { hr: { employee: { actions: ['read'] }, salary: { actions: ['read'] } } } }), hrModule);
    expect(permissions).toEqual({ 'employee.read': 'own', 'salary.read': 'all' });
  });

  it('ignores grants for resources or actions the module does not have', () => {
    const access = resolveModuleAccess(person({ profileGrants: { hr: { ghost: { actions: ['read'] }, salary: { actions: ['approve'] } } } }), hrModule);
    expect(access.hasAccess).toBe(false);
    expect(access.permissions).toEqual({});
  });
});
