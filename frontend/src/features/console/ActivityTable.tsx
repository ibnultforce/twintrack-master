import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/Card';
import { Placeholder } from '@/components/ui/Notice';
import { formatDateTime, humanizeKey, maskIpAddress } from '@/lib/format';
import { activityLabel } from './activityLabels';
import type { ActivityEntry } from './consoleTypes';
import styles from './console.module.css';

export function ActivityTable({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) return <Placeholder>No activity to show.</Placeholder>;

  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Who</th>
          <th scope="col">Action</th>
          <th scope="col">Record</th>
          <th scope="col">IP address</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const { label, tone } = activityLabel(entry.action);
          return (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.at)}</td>
              <td className={styles.personName}>{entry.actorName ?? 'System'}</td>
              <td>
                <Badge tone={tone}>{label}</Badge>
              </td>
              <td>
                {entry.targetName ?? '·'}
                {entry.module && <span className={styles.personMeta}> · {humanizeKey(entry.module)}</span>}
              </td>
              <td>{maskIpAddress(entry.ip)}</td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}
