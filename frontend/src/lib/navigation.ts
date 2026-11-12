export interface NavigationItem {
  href: string;
  label: string;
  /** The Master permission a screen needs. Screens without one are open to anyone signed in. */
  permission?: string;
  /** For the Access screen: open to anyone who reads people or gives profiles. */
  needsAccessRights?: boolean;
}

export interface NavigationRights {
  can: (permission: string) => boolean;
  canChangeAccess: boolean;
}

export const ACCOUNT_NAVIGATION: NavigationItem[] = [
  { href: '/modules', label: 'Your modules' },
  { href: '/directory', label: 'Directory' },
  { href: '/records', label: 'Records' },
  { href: '/my-permissions', label: 'Your permissions' },
  { href: '/profile', label: 'Your profile' },
  { href: '/api-access', label: 'Apps and API tokens' },
];

export const CONSOLE_NAVIGATION: NavigationItem[] = [
  { href: '/overview', label: 'Overview', permission: 'user.read' },
  { href: '/registered-modules', label: 'Modules', permission: 'module.read' },
  // { href: '/permissions', label: 'Permissions', permission: 'module.read' },
  { href: '/org-roles', label: 'Roles', permission: 'orgRole.read' },
  { href: '/profiles', label: 'Profiles', permission: 'accessProfile.read' },
  { href: '/people', label: 'People', permission: 'user.read' },
  { href: '/clients', label: 'Clients', permission: 'client.read' },
  { href: '/access', label: 'Access', needsAccessRights: true },
  { href: '/api-tokens', label: 'API tokens', permission: 'apiToken.read' },
  { href: '/activity', label: 'Activity log', permission: 'audit.read' },
];

export function isNavigationItemAllowed(item: NavigationItem, { can, canChangeAccess }: NavigationRights): boolean {
  if (item.needsAccessRights) return canChangeAccess || can('user.read');
  return !item.permission || can(item.permission);
}

export const isCurrentSection = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
