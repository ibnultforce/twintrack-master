'use client';

import { useCallback } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadError, Placeholder } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatTile, StatTiles } from '@/components/ui/StatTiles';
import { useSignedInAccount } from '@/features/auth/AuthProvider';
import { formatLongDate } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';
import { ActivityTable } from './ActivityTable';
import { consoleApi } from './consoleApi';
import type { ConsoleUser, ModuleAccessOptions } from './consoleTypes';
import styles from './console.module.css';

const OVERVIEW_USER_LIMIT = 100;
const RECENT_ACTIVITY_COUNT = 6;

type AttentionTone = 'warning' | 'danger' | 'good';

const ATTENTION_TONE_CLASS_NAMES: Record<AttentionTone, string | undefined> = {
  warning: styles.attentionWarning,
  danger: styles.attentionDanger,
  good: styles.attentionGood,
};

const peopleCount = (count: number) => (count === 1 ? '1 person' : `${count} people`);

function holdsRoleIn(user: ConsoleUser, modules: ModuleAccessOptions[]): boolean {
  return modules.some((module) => user.assignments[module.key] || user.privileges[module.key]?.length);
}

function findAttentionItems(users: ConsoleUser[], modules: ModuleAccessOptions[]): { text: string; tone: AttentionTone }[] {
  const active = users.filter((user) => user.status === 'active');
  const deactivatedWithAccess = users.filter((user) => user.status === 'inactive' && holdsRoleIn(user, modules)).length;
  const withoutAccess = active.filter((user) => !user.superAdmin && !holdsRoleIn(user, modules)).length;
  const onTemporaryPassword = active.filter((user) => user.mustChangePassword).length;

  const items: { text: string; tone: AttentionTone }[] = [];
  if (deactivatedWithAccess > 0) items.push({ text: `${peopleCount(deactivatedWithAccess)} deactivated but still holding roles`, tone: 'danger' });
  if (onTemporaryPassword > 0) items.push({ text: `${peopleCount(onTemporaryPassword)} still on a temporary password`, tone: 'warning' });
  if (withoutAccess > 0) items.push({ text: `${peopleCount(withoutAccess)} with no access to any module`, tone: 'warning' });
  return items;
}

function ModuleMeter({ name, count, total }: { name: string; count: number; total: number }) {
  const sharePercent = total === 0 ? 0 : (count / total) * 100;
  return (
    <div className={styles.meterRow}>
      <div className={styles.meterText}>
        <span>{name}</span>
        <span className={styles.meterValue}>{count}</span>
      </div>
      <div className={styles.meterTrack} aria-hidden="true">
        <div className={styles.meterFill} style={{ width: `${sharePercent}%` }} />
      </div>
    </div>
  );
}

function RecentActivity() {
  const load = useCallback(async () => (await consoleApi.listActivity({ page: 1, pageSize: RECENT_ACTIVITY_COUNT })).entries, []);
  const { data: entries, error, reload } = useAsyncData(load);

  return (
    <Card title="Recent activity" titleAside={<ButtonLink href="/console/activity" variant="link">View all</ButtonLink>}>
      {error !== undefined && <LoadError error={error} onRetry={reload} />}
      {entries && <ActivityTable entries={entries} />}
    </Card>
  );
}

export function OverviewScreen() {
  const { masterPermissions } = useSignedInAccount();
  const load = useCallback(async () => {
    const [{ users, total }, modules] = await Promise.all([
      consoleApi.listUsers({ page: 1, pageSize: OVERVIEW_USER_LIMIT }),
      consoleApi.listAccessOptions(),
    ]);
    return { users, total, modules };
  }, []);
  const { data, error, isLoading, reload } = useAsyncData(load);

  const header = <PageHeader title="Overview" subtitle={formatLongDate(new Date())} />;
  if (error !== undefined) return <>{header}<LoadError error={error} onRetry={reload} /></>;
  if (isLoading && !data) return <>{header}<Placeholder>Loading…</Placeholder></>;
  if (!data) return header;

  const { users, total, modules } = data;
  const activeCount = users.filter((user) => user.status === 'active').length;
  const superAdminCount = users.filter((user) => user.superAdmin && user.status === 'active').length;
  const attentionItems = findAttentionItems(users, modules);

  return (
    <>
      {header}
      <div className={styles.stack}>
        <StatTiles>
          <StatTile label="People" value={total} />
          <StatTile label="Active" value={activeCount} />
          <StatTile label="Deactivated" value={users.length - activeCount} />
          <StatTile label="Modules loaded" value={modules.length} />
          <StatTile label="Super admins" value={superAdminCount} />
        </StatTiles>
        <div className={styles.overviewColumns}>
          {masterPermissions['audit.read'] ? (
            <RecentActivity />
          ) : (
            <Card title="Recent activity">
              <Placeholder>Your role doesn&apos;t include the activity log.</Placeholder>
            </Card>
          )}
          <div className={styles.stack}>
            <Card title="Needs attention">
              {attentionItems.length === 0 ? (
                <p className={styles.muted}>Nothing right now.</p>
              ) : (
                <ul className={styles.attentionList}>
                  {attentionItems.map(({ text, tone }) => (
                    <li key={text} className={styles.attentionItem}>
                      <span className={`${styles.attentionDot} ${ATTENTION_TONE_CLASS_NAMES[tone]}`} aria-hidden="true" />
                      {text}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Active people with access, by module">
              {modules.map((module) => (
                <ModuleMeter
                  key={module.key}
                  name={module.name}
                  total={activeCount}
                  count={users.filter((user) => user.status === 'active' && (user.superAdmin || holdsRoleIn(user, [module]))).length}
                />
              ))}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
