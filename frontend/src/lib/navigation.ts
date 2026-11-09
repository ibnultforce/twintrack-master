export interface NavigationItem {
  href: string;
  label: string;
  /** The Master permission a screen needs. Screens without one are open to anyone signed in. */
  permission?: string;
  /** For screens that depend on being able to change someone's access, which can come from any module. */
  needsAccessRights?: boolean;
  /** Also open to anyone who can edit roles in at least one module. */
  opensForRoleEditors?: boolean;
}

export interface NavigationRights {
  can: (permission: string) => boolean;
  canChangeAccess: boolean;
  canEditRoles: boolean;
}

export const ACCOUNT_NAVIGATION: NavigationItem[] = [
  { href: '/modules', label: 'Your modules' },
  { href: '/my-permissions', label: 'Your permissions' },
  { href: '/profile', label: 'Your profile' },
];

export const CONSOLE_NAVIGATION: NavigationItem[] = [
  { href: '/overview', label: 'Overview', permission: 'user.read' },
  { href: '/people', label: 'People', permission: 'user.read' },
  { href: '/access', label: 'Access', needsAccessRights: true },
  { href: '/roles', label: 'Roles', permission: 'role.read', opensForRoleEditors: true },
  { href: '/permissions', label: 'Permissions', permission: 'role.read' },
  { href: '/registered-modules', label: 'Modules', permission: 'module.read' },
  { href: '/activity', label: 'Activity log', permission: 'audit.read' },
];

export function isNavigationItemAllowed(item: NavigationItem, { can, canChangeAccess, canEditRoles }: NavigationRights): boolean {
  if (item.needsAccessRights) return canChangeAccess;
  if (item.opensForRoleEditors && canEditRoles) return true;
  return !item.permission || can(item.permission);
}

export const isCurrentSection = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
