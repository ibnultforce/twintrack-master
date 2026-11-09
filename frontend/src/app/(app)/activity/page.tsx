'use client';

import { useState } from 'react';
import { ActivityTable } from '@/components/ActivityTable';
import { Card, Chips, Loaded, PageHead, Pagination } from '@/components/ui';
import { listActivity } from '@/lib/api/modules';
import { useLoad } from '@/lib/useLoad';

const PAGE_SIZE = 20;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'auth.', label: 'Sign-in' },
  { value: 'user.', label: 'People' },
  { value: 'role.', label: 'Roles' },
  { value: 'module.', label: 'Modules' },
  { value: 'salary.', label: 'Salaries' },
];

export default function ActivityPage() {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);

  const activity = useLoad(
    () => listActivity({ page, pageSize: PAGE_SIZE, actionPrefix: filter === 'all' ? undefined : filter }),
    [page, filter],
  );

  const changeFilter = (next: string) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <>
      <PageHead title="Activity log" subtitle="Who signed in, and who changed people, access or modules" />
      <div className="toolbar">
        <Chips label="Filter by action" value={filter} onChange={changeFilter} options={FILTERS} />
      </div>
      <Loaded state={activity}>
        {({ entries, total }) => (
          <Card>
            <ActivityTable entries={entries} />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
          </Card>
        )}
      </Loaded>
    </>
  );
}
