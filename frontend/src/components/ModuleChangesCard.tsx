'use client';

import { useState } from 'react';
import { describeError } from '@/lib/api/http';
import { listModuleChanges, markModuleChangeDone, type ModuleChange, type ModuleChangeKind } from '@/lib/api/modules';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { Card, Loaded, Notice, Pill, type PillTone } from './ui';

const KIND_TONES: Record<ModuleChangeKind, PillTone> = { added: 'good', removed: 'danger', changed: 'warning' };
const KIND_LABELS: Record<ModuleChangeKind, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

function describeVersion(change: ModuleChange): string {
  return change.versionBefore && change.versionBefore !== change.versionAfter ? `v${change.versionBefore} → v${change.versionAfter}` : `v${change.versionAfter}`;
}

function ChangeEntry({ change, canMarkDone, onMarkDone }: { change: ModuleChange; canMarkDone: boolean; onMarkDone: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const markDone = async () => {
    setError('');
    setIsSaving(true);
    try {
      await onMarkDone();
    } catch (failure) {
      setError(describeError(failure));
      setIsSaving(false);
    }
  };

  return (
    <div className="change-entry">
      <div className="pane-row">
        <div>
          <div className="strong">{change.source === 'schema' ? 'Schema import' : 'Manifest import'} · {describeVersion(change)}</div>
          <div className="meta">
            {formatTime(change.changedAt)} by {change.changedByName ?? 'unknown'}
            {change.status === 'done' && change.doneAt ? ` · done ${formatTime(change.doneAt)} by ${change.doneByName ?? 'unknown'}` : ''}
          </div>
        </div>
        {change.status === 'pending' && canMarkDone ? <button type="button" className="btn" disabled={isSaving} onClick={() => void markDone()}>Mark done</button> : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ul className="change-items">
        {change.items.map((item) => (
          <li key={`${item.kind} ${item.subject} ${item.detail ?? ''}`}>
            <div><Pill tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Pill> <span className="strong">{item.subject}</span>{item.detail ? <span className="muted">: {item.detail}</span> : null}</div>
            <ul className="meta">{item.where.map((place) => <li key={place}>{place}</li>)}</ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What manifest and schema imports changed in a module, and where the code and docs need work to match. Each import
 * stays pending until a developer marks it done.
 */
export function ModuleChangesCard({ moduleKey, moduleName, canMarkDone, refreshKey }: { moduleKey: string; moduleName: string; canMarkDone: boolean; refreshKey: unknown }) {
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const changes = useLoad(() => listModuleChanges(moduleKey, status), [moduleKey, status, refreshKey], moduleKey);

  const markDone = async (changeId: string) => {
    await markModuleChangeDone(moduleKey, changeId);
    changes.reload();
  };

  const toggle = (
    <button type="button" className="link" onClick={() => setStatus(status === 'pending' ? 'done' : 'pending')}>
      {status === 'pending' ? 'Show done' : 'Show pending'}
    </button>
  );

  return (
    <Card title={status === 'pending' ? 'Changes to build' : 'Changes built'} aside={toggle}>
      <Loaded state={changes}>
        {(result) => result.changes.length === 0 ? (
          <p className="empty">{status === 'pending' ? `Nothing to build: no import has changed ${moduleName} since its changes were last marked done.` : 'No changes have been marked done yet.'}</p>
        ) : (
          <div className="change-list">
            {status === 'pending' ? <p className="muted">Imports changed these. Update each place listed, then mark the import done. A local development server also lists them in manifests/changes/{moduleKey}.md.</p> : null}
            {result.changes.map((change) => <ChangeEntry key={change.id} change={change} canMarkDone={canMarkDone} onMarkDone={() => markDone(change.id)} />)}
          </div>
        )}
      </Loaded>
    </Card>
  );
}
