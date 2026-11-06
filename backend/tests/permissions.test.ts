import { describe, expect, it } from 'vitest';
import { resolveModuleAccess } from '../src/modules/master/access/permissions.js';
import type { ManifestResource, ManifestRole } from '../src/modules/master/moduleRegistry/manifest.js';

const resources: ManifestResource[] = [
  { key: 'employee', label: 'Employees', actions: ['read', 'update'], scoped: true },
  { key: 'salary', label: 'Salaries', actions: ['read', 'update'], grantable: ['read'] },
  { key: 'leave', label: 'Leave', actions: ['read', 'approve'], scoped: true, grantable: ['read', 'approve'] },
];

const roles: ManifestRole[] = [
  { key: 'admin', name: 'Admin', grants: '*' },
  { key: 'manager', name: 'Manager', grants: { employee: { actions: ['read'], scope: 'team' }, leave: { actions: ['read'], scope: 'all' } } },
  { key: 'careless', name: 'No scope stated', grants: { employee: { actions: ['read'] }, salary: { actions: ['read'] } } },
];

const hrModule = { key: 'hr', resources, roles };

const person = (overrides: { superAdmin?: boolean; assignments?: Record<string, string>; privileges?: Record<string, string[]> } = {}) => ({
  superAdmin: false,
  assignments: {},
  privileges: {},
  ...overrides,
});

describe('resolveModuleAccess', () => {
  it('gives nothing to someone with no role or privilege', () => {
    expect(resolveModuleAccess(person(), hrModule)).toEqual({
      hasAccess: false,
      role: null,
      roleName: null,
      permissions: {},
      specialPrivileges: [],
    });
  });

  it('applies the actions and scopes of a role template', () => {
    const access = resolveModuleAccess(person({ assignments: { hr: 'manager' } }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, role: 'manager', roleName: 'Manager' });
    expect(access.permissions).toEqual({ 'employee.read': 'team', 'leave.read': 'all' });
  });

  it('gives a wildcard role every action, across all data', () => {
    const { permissions } = resolveModuleAccess(person({ assignments: { hr: 'admin' } }), hrModule);
    expect(Object.keys(permissions)).toHaveLength(6);
    expect(new Set(Object.values(permissions))).toEqual(new Set(['all']));
  });

  it('gives a super admin everything without needing a role', () => {
    const access = resolveModuleAccess(person({ superAdmin: true }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, role: 'super-admin', roleName: 'Super admin' });
    expect(access.permissions['salary.update']).toBe('all');
  });

  it('grants nothing from a role the module no longer has, or a role in another module', () => {
    expect(resolveModuleAccess(person({ assignments: { hr: 'removed-role' } }), hrModule).hasAccess).toBe(false);
    expect(resolveModuleAccess(person({ assignments: { account: 'admin' } }), hrModule).hasAccess).toBe(false);
  });

  it('uses the narrowest scope when a scoped resource states none, and all for an unscoped one', () => {
    const { permissions } = resolveModuleAccess(person({ assignments: { hr: 'careless' } }), hrModule);
    expect(permissions).toEqual({ 'employee.read': 'own', 'salary.read': 'all' });
  });

  it('gives access from a special privilege alone, at team scope on scoped resources', () => {
    const access = resolveModuleAccess(person({ privileges: { hr: ['leave.approve', 'salary.read'] } }), hrModule);
    expect(access).toMatchObject({ hasAccess: true, role: null, roleName: null });
    expect(access.permissions).toEqual({ 'leave.approve': 'team', 'salary.read': 'all' });
    expect(access.specialPrivileges).toEqual(['leave.approve', 'salary.read']);
  });

  it('keeps the wider scope when a role and a privilege overlap', () => {
    const access = resolveModuleAccess(person({ assignments: { hr: 'manager' }, privileges: { hr: ['leave.read'] } }), hrModule);
    expect(access.permissions['leave.read']).toBe('all');
  });

  it('ignores a privilege the module does not allow granting', () => {
    const access = resolveModuleAccess(person({ privileges: { hr: ['salary.update', 'ghost.read', 'nonsense'] } }), hrModule);
    expect(access.hasAccess).toBe(false);
    expect(access.permissions).toEqual({});
    expect(access.specialPrivileges).toEqual([]);
  });
});
