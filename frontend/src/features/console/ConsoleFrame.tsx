'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Notice, Placeholder } from '@/components/ui/Notice';
import { useSignedInAccount } from '@/features/auth/AuthProvider';
import { USE_SAMPLE_CONSOLE_DATA } from '@/lib/config';
import { canOpenConsolePath } from './consoleNavigation';
import styles from './console.module.css';

/** Wraps every console screen. The API makes the real decision, so this only avoids showing dead ends. */
export function ConsoleFrame({ children }: { children: ReactNode }) {
  const { masterPermissions } = useSignedInAccount();
  const pathname = usePathname();

  if (!canOpenConsolePath(pathname, masterPermissions)) {
    return <Placeholder>You don&apos;t have permission to open this page.</Placeholder>;
  }

  return (
    <>
      {USE_SAMPLE_CONSOLE_DATA && (
        <div className={styles.banner}>
          <Notice tone="warning">
            Sample data. These screens show the example team until the admin API is built. Changes aren&apos;t saved, and they
            reset when the page reloads.
          </Notice>
        </div>
      )}
      {children}
    </>
  );
}
