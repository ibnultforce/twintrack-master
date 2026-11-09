'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ACCOUNT_NAVIGATION, CONSOLE_NAVIGATION, isCurrentSection, isNavigationItemAllowed, type NavigationItem, type NavigationRights } from '@/lib/navigation';
import { useSession } from '@/session/SessionProvider';

const CenteredMessage = ({ children }: { children: ReactNode }) => <div className="centered"><p className="loading" role="status">{children}</p></div>;

export function AppShell({ children }: { children: ReactNode }) {
  const { status, profile, can, canChangeAccess, canEditRoles, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const mustChangePassword = profile?.mustChangePassword ?? false;

  useEffect(() => {
    if (status === 'signed-out' || status === 'unavailable') router.replace('/sign-in');
    else if (mustChangePassword) router.replace('/change-password');
  }, [status, mustChangePassword, router]);

  if (status !== 'signed-in' || !profile || mustChangePassword) return <CenteredMessage>Loading…</CenteredMessage>;

  const isAllowed = (item: NavigationItem) => isNavigationItemAllowed(item, { can, canChangeAccess, canEditRoles });
  const consoleNavigation = CONSOLE_NAVIGATION.filter(isAllowed);
  const currentConsoleItem = CONSOLE_NAVIGATION.find((item) => isCurrentSection(pathname, item.href));

  const navLink = (item: NavigationItem) => (
    <Link key={item.href} className="nav-link" href={item.href} aria-current={isCurrentSection(pathname, item.href) ? 'page' : undefined}>
      {item.label}
    </Link>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/modules"><i aria-hidden="true" />TwinTrack</Link>
        <nav className="nav-groups" aria-label="Main">
          <div className="nav-group">
            <p className="nav-label">Account</p>
            {ACCOUNT_NAVIGATION.map(navLink)}
          </div>
          {consoleNavigation.length > 0 ? (
            <div className="nav-group">
              <p className="nav-label">Administration</p>
              {consoleNavigation.map(navLink)}
            </div>
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <span>{profile.superAdmin ? 'Super admin' : profile.title}</span>
          <span>{profile.name}</span>
          <button type="button" className="link" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main>
        {currentConsoleItem && !isAllowed(currentConsoleItem)
          ? <section className="card"><p className="empty">Your role doesn&apos;t include this screen.</p></section>
          : children}
      </main>
    </div>
  );
}

export function firstConsoleHref(rights: NavigationRights): string | null {
  return CONSOLE_NAVIGATION.find((item) => isNavigationItemAllowed(item, rights))?.href ?? null;
}
