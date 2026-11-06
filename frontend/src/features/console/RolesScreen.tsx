'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { ChipFilter } from '@/components/ui/ChipFilter';
import { LoadError, Placeholder } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAsyncData } from '@/lib/useAsyncData';
import { consoleApi } from './consoleApi';
import type { RoleTemplate } from './consoleTypes';
import styles from './console.module.css';

const ALL_MODULES = 'all';

const listRoles = () => consoleApi.listRoles();

function moduleFilterOptions(roles: RoleTemplate[]): { value: string; label: string }[] {
  const moduleNames = new Map(roles.map((role) => [role.module, role.moduleName]));
  return [{ value: ALL_MODULES, label: 'All' }, ...[...moduleNames].map(([value, label]) => ({ value, label }))];
}

export function RolesScreen() {
  const { data: roles, error, isLoading, reload } = useAsyncData(listRoles);
  const [selectedModule, setSelectedModule] = useState(ALL_MODULES);

  const filterOptions = useMemo(() => moduleFilterOptions(roles ?? []), [roles]);
  const shownRoles = roles?.filter((role) => selectedModule === ALL_MODULES || role.module === selectedModule);

  return (
    <>
      <PageHeader title="Roles" subtitle="What each role can do" />
      <div className={styles.toolbar}>
        <ChipFilter label="Filter by module" options={filterOptions} selected={selectedModule} onSelect={setSelectedModule} />
        <span className={styles.note}>Role templates come from each module&apos;s manifest, so they can&apos;t be edited here.</span>
      </div>
      {error !== undefined && <LoadError error={error} onRetry={reload} />}
      {isLoading && !roles && <Placeholder>Loading…</Placeholder>}
      <div className={styles.roleGrid}>
        {shownRoles?.map((role) => (
          <Card key={`${role.module}.${role.key}`} title={role.name} titleAside={<Badge tone="accent">{role.moduleName}</Badge>}>
            <div className={styles.stack}>
              <p className={styles.muted}>{role.description}</p>
              <div className={styles.badges}>
                {role.grants.map((grant) => (
                  <Badge key={grant} tone="neutral">
                    {grant}
                  </Badge>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
