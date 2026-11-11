'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '@/lib/api/http';
import { ACCOUNT_NAVIGATION, CONSOLE_NAVIGATION, isCurrentSection, isNavigationItemAllowed, type NavigationItem, type NavigationRights } from '@/lib/navigation';
import { useSession } from '@/session/SessionProvider';
import { PersonPhoto } from './PersonPhoto';
import { Notice } from './ui';

const CenteredMessage = ({ children }: { children: ReactNode }) => <div className="centered"><p className="loading" role="status">{children}</p></div>;

/** Shown on every screen while a super admin sees the app as someone else, so it's never mistaken for their own. */
function ImpersonationBanner({ name, by }: { name: string; by: string }) {
  const { stopImpersonating } = useSession();
  const [error, setError] = useState('');
  const stop = async () => {
    setError('');
    try {
      await stopImpersonating();
    } catch (failure) {
      setError(describeError(failure));
    }
  };
  return (
    <div className="impersonation-banner" role="status">
      <span>You ({by}) are signed in as <b>{name}</b>, and see exactly what their access shows. Development only.</span>
      <button type="button" className="btn btn-small" onClick={() => void stop()}>Stop</button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, profile, can, canChangeAccess, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === 'signed-out' || status === 'unavailable') router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  if (status !== 'signed-in' || !profile) return <CenteredMessage>Loading…</CenteredMessage>;

  const isAllowed = (item: NavigationItem) => isNavigationItemAllowed(item, { can, canChangeAccess });
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
          <div className="person">
            <PersonPhoto personId={profile.id} name={profile.name} photoUpdatedAt={profile.photoUpdatedAt} />
            <div>
              <div className="strong">{profile.name}</div>
              <div className="meta">{profile.superAdmin ? 'Super admin' : profile.title}</div>
            </div>
          </div>
          <button type="button" className="link" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main>
        {profile.impersonatedBy ? <ImpersonationBanner name={profile.name} by={profile.impersonatedBy.name} /> : null}
        {currentConsoleItem && !isAllowed(currentConsoleItem)
          ? <section className="card"><p className="empty">Your access doesn&apos;t include this screen.</p></section>
          : children}
      </main>
    </div>
  );
}

export function firstConsoleHref(rights: NavigationRights): string | null {
  return CONSOLE_NAVIGATION.find((item) => isNavigationItemAllowed(item, rights))?.href ?? null;
}
