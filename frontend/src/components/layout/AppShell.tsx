'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/ui/BrandMark';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { useAuth, useSignedInAccount } from '@/features/auth/AuthProvider';
import { allowedConsoleNavigation } from '@/features/console/consoleNavigation';
import { errorMessage } from '@/lib/api/client';
import { humanizeKey } from '@/lib/format';
import styles from './AppShell.module.css';

const ACCOUNT_NAVIGATION = [
  { href: '/', label: 'Your modules' },
  { href: '/profile', label: 'Your profile' },
];

function NavLink({ href, label, isActive }: { href: string; label: string; isActive: boolean }) {
  return (
    <Link href={href} className={styles.navLink} aria-current={isActive ? 'page' : undefined}>
      {label}
    </Link>
  );
}

function isActivePath(pathname: string, href: string, isExactMatch: boolean): boolean {
  return isExactMatch ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const { profile, masterPermissions } = useSignedInAccount();
  const pathname = usePathname();
  const [signOutError, setSignOutError] = useState<unknown>();

  const consoleNavigation = allowedConsoleNavigation(masterPermissions);
  const roleLabel = profile.superAdmin ? 'Super admin' : (profile.title ?? humanizeKey(profile.department));

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brandLink}>
          <BrandMark />
        </Link>
        <nav className={styles.navigation} aria-label="Main">
          <div className={styles.navGroup}>
            <p className={styles.navGroupLabel}>Account</p>
            {ACCOUNT_NAVIGATION.map(({ href, label }) => (
              <NavLink key={href} href={href} label={label} isActive={pathname === href} />
            ))}
          </div>
          {consoleNavigation.length > 0 && (
            <div className={styles.navGroup}>
              <p className={styles.navGroupLabel}>Administration</p>
              {consoleNavigation.map(({ href, label, isExactMatch }) => (
                <NavLink key={href} href={href} label={label} isActive={isActivePath(pathname, href, isExactMatch)} />
              ))}
            </div>
          )}
        </nav>
        <div className={styles.sidebarFooter}>
          <p className={styles.footerRole}>{roleLabel}</p>
          <p className={styles.footerName}>{profile.name}</p>
          <Button variant="link" onClick={() => signOut().catch(setSignOutError)}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className={styles.content}>
        {signOutError !== undefined && <Notice tone="danger">{errorMessage(signOutError)}</Notice>}
        {children}
      </main>
    </div>
  );
}
