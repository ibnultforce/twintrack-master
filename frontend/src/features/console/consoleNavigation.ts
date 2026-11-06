import type { PermissionMap } from '@/features/auth/authApi';

interface ConsoleNavigationItem {
  href: string;
  label: string;
  /** The Master permission needed to see this screen. It matches the permission on the screen's main API route. */
  permission: string;
  isExactMatch: boolean;
}

const CONSOLE_NAVIGATION: ConsoleNavigationItem[] = [
  { href: '/console', label: 'Overview', permission: 'user.read', isExactMatch: true },
  { href: '/console/users', label: 'People', permission: 'user.read', isExactMatch: false },
  { href: '/console/roles', label: 'Roles', permission: 'role.read', isExactMatch: false },
  { href: '/console/modules', label: 'Modules', permission: 'module.read', isExactMatch: false },
  { href: '/console/activity', label: 'Activity log', permission: 'audit.read', isExactMatch: false },
];

export function allowedConsoleNavigation(permissions: PermissionMap): ConsoleNavigationItem[] {
  return CONSOLE_NAVIGATION.filter((item) => permissions[item.permission]);
}

/** Says whether someone may open a console address. Addresses outside the list above are refused. */
export function canOpenConsolePath(pathname: string, permissions: PermissionMap): boolean {
  const item = CONSOLE_NAVIGATION.find(({ href, isExactMatch }) =>
    isExactMatch ? pathname === href : pathname === href || pathname.startsWith(`${href}/`),
  );
  return Boolean(item && permissions[item.permission]);
}
