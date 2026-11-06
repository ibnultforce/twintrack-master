'use client';

import { useCallback, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { ChipFilter } from '@/components/ui/ChipFilter';
import { LoadError, Placeholder } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { useAsyncData } from '@/lib/useAsyncData';
import { ActivityTable } from './ActivityTable';
import { consoleApi } from './consoleApi';
import styles from './console.module.css';

const PAGE_SIZE = 10;

const ACTION_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'auth.', label: 'Sign-in' },
  { value: 'user.', label: 'People' },
  { value: 'module.', label: 'Modules' },
] as const;

type ActionFilter = (typeof ACTION_FILTERS)[number]['value'];

export function ActivityScreen() {
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
  const [page, setPage] = useState(1);

  const load = useCallback(
    () => consoleApi.listActivity({ page, pageSize: PAGE_SIZE, actionPrefix: actionFilter === 'all' ? undefined : actionFilter }),
    [page, actionFilter],
  );
  const { data, error, isLoading, reload } = useAsyncData(load);

  function selectFilter(filter: ActionFilter) {
    setActionFilter(filter);
    setPage(1);
  }

  return (
    <>
      <PageHeader title="Activity log" subtitle="Who signed in, and who changed people, access or modules" />
      <div className={styles.toolbar}>
        <ChipFilter label="Filter by action" options={ACTION_FILTERS} selected={actionFilter} onSelect={selectFilter} />
        <span className={styles.note}>The log can&apos;t be edited or deleted by anyone, including admins.</span>
      </div>
      <Card>
        {error !== undefined && <LoadError error={error} onRetry={reload} />}
        {isLoading && !data && <Placeholder>Loading…</Placeholder>}
        {data && (
          <>
            <ActivityTable entries={data.entries} />
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
