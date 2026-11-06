'use client';

import { useCallback } from 'react';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { LoadError, Placeholder } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { useSignedInAccount } from '@/features/auth/AuthProvider';
import { listMyModules, type AccessibleModule } from '@/features/auth/authApi';
import { allowedConsoleNavigation } from '@/features/console/consoleNavigation';
import { MASTER_MODULE_KEY } from '@/lib/config';
import { formatLongDate } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';
import styles from './portal.module.css';

function ModuleAction({ module, consolePath }: { module: AccessibleModule; consolePath: string | undefined }) {
  // Master's own screens are part of this app, so it opens without leaving the page.
  if (module.key === MASTER_MODULE_KEY) {
    return consolePath ? <ButtonLink href={consolePath} variant="primary">Open</ButtonLink> : null;
  }
  if (!module.frontendUrl) return <Badge tone="neutral">Not available yet</Badge>;
  return (
    <ButtonLink href={module.frontendUrl} variant="primary" isExternal>
      Open
    </ButtonLink>
  );
}

/** The home page: only the modules this person can use. */
export function ModulesScreen() {
  const { masterPermissions } = useSignedInAccount();
  const load = useCallback(async () => (await listMyModules()).modules, []);
  const { data: modules, error, isLoading, reload } = useAsyncData(load);
  const consolePath = allowedConsoleNavigation(masterPermissions)[0]?.href;

  return (
    <>
      <PageHeader title="Your modules" subtitle={formatLongDate(new Date())} />
      {error !== undefined && <LoadError error={error} onRetry={reload} />}
      {isLoading && !modules && <Placeholder>Loading your modules…</Placeholder>}
      {modules?.length === 0 && (
        <Placeholder>You don&apos;t have access to any modules yet. Ask HR to give you a role.</Placeholder>
      )}
      <div className={styles.moduleGrid}>
        {modules?.map((module) => (
          <article key={module.key} className={styles.moduleCard}>
            <div className={styles.moduleHeading}>
              <h2>{module.name}</h2>
              <Badge tone={module.roleName ? 'accent' : 'neutral'}>{module.roleName ?? 'Special privileges'}</Badge>
            </div>
            {module.description && <p className={styles.moduleDescription}>{module.description}</p>}
            <div className={styles.moduleAction}>
              <ModuleAction module={module} consolePath={consolePath} />
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
