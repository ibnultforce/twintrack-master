'use client';

import type { AuditEntry } from '@/lib/api/types';
import { formatTime, humanize } from '@/lib/format';
import { Pill, type PillTone } from './ui';

function toneOf(action: string): PillTone {
  if (/(failed|reused|removed|deactivated)/.test(action)) return 'danger';
  if (/(created|imported|approved)/.test(action)) return 'good';
  if (/(changed|updated|reset)/.test(action)) return 'accent';
  return 'neutral';
}

const labelOf = (action: string) => humanize(action.slice(action.indexOf('.') + 1));

export function ActivityTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="empty">No activity to show.</p>;
  return (
    <div className="table-box">
      <table>
        <thead>
          <tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">About</th><th scope="col">Module</th></tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="nowrap">{formatTime(entry.at)}</td>
              <td>{entry.actorName ?? entry.actorId ?? '·'}</td>
              <td><Pill tone={toneOf(entry.action)}>{labelOf(entry.action)}</Pill></td>
              <td>
                {entry.targetName ?? entry.targetId ?? '·'}
                {entry.reason ? <div className="meta">{entry.reason}</div> : null}
              </td>
              <td>{entry.module ?? '·'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
