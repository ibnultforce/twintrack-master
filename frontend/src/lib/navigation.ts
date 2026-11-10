export interface NavigationItem {
  href: string;
  label: string;
  /** The Master permission a screen needs. Screens without one are open to anyone signed in. */
  permission?: string;
  /** For screens that depend on being able to change someone's access, which can come from any module. */
  needsAccessRights?: boolean;
  /** Open to anyone who can read or edit permission sets in at least one module. */
  needsPermissionSetRights?: boolean;
}

export interface NavigationRights {
  can: (permission: string) => boolean;
  canChangeAccess: boolean;
  canEditPermissionSets: boolean;
}

export const ACCOUNT_NAVIGATION: NavigationItem[] = [
  { href: '/modules', label: 'Your modules' },
  { href: '/records', label: 'Records' },
  { href: '/my-permissions', label: 'Your permissions' },
  { href: '/profile', label: 'Your profile' },
];

export const CONSOLE_NAVIGATION: NavigationItem[] = [
  { href: '/overview', label: 'Overview', permission: 'user.read' },
  { href: '/registered-modules', label: 'Modules', permission: 'module.read' },
  { href: '/permissions', label: 'Permissions', permission: 'module.read' },
  { href: '/org-roles', label: 'Org roles', permission: 'orgRole.read' },
  { href: '/profiles', label: 'Profiles', permission: 'accessProfile.read' },
  { href: '/permission-sets', label: 'Permission sets', needsPermissionSetRights: true },
  { href: '/people', label: 'People', permission: 'user.read' },
  { href: '/access', label: 'Access', needsAccessRights: true },
  { href: '/activity', label: 'Activity log', permission: 'audit.read' },
];

export function isNavigationItemAllowed(item: NavigationItem, { can, canChangeAccess, canEditPermissionSets }: NavigationRights): boolean {
  if (item.needsAccessRights) return canChangeAccess;
  if (item.needsPermissionSetRights) return canEditPermissionSets;
  return !item.permission || can(item.permission);
}

export const isCurrentSection = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
