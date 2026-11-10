'use client';

import { useState } from 'react';
import { describeError } from '@/lib/api/http';
import type { AccessOption } from '@/lib/api/types';
import { setUserPermissionSets } from '@/lib/api/users';
import { Notice } from './ui';

/** The permission sets one person holds in one module. The API enforces every rule, and this only hides what can't work. */
export function ModuleAccessEditor({ option, userId, heldSets, profileGrants, canEdit, onChanged }: {
  option: AccessOption;
  userId: string;
  heldSets: string[];
  /** What the person's profile already gives here, shown so nobody adds a set for what they have. */
  profileGrants: string[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [toGive, setToGive] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const nameOf = (setKey: string) => option.permissionSets.find((permissionSet) => permissionSet.key === setKey)?.name ?? setKey;
  const offered = option.permissionSets.filter((permissionSet) => !heldSets.includes(permissionSet.key));

  const save = async (permissionSets: string[], withReason?: string) => {
    setIsBusy(true);
    setError('');
    try {
      await setUserPermissionSets(userId, option.key, permissionSets, withReason);
      setToGive('');
      setReason('');
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsBusy(false);
    }
  };

  const give = () => {
    if (!toGive) return;
    if (!reason.trim()) {
      setError('Say why this person needs the permission set. It goes in the activity log.');
      return;
    }
    void save([...heldSets, toGive], reason.trim());
  };

  return (
    <div className="access-module">
      <h3>{option.name}</h3>
      {profileGrants.length > 0 ? <p className="meta">From their profile: {profileGrants.join(', ')}</p> : null}
      {heldSets.length === 0 ? <p className="muted">No permission sets.</p> : null}
      {heldSets.map((setKey) => (
        <div className="privilege" key={setKey}>
          <div>
            <span className="strong">{nameOf(setKey)}</span>
            <div className="meta">{option.permissionSets.find((permissionSet) => permissionSet.key === setKey)?.grants.join(', ') || 'Gives nothing yet'}</div>
          </div>
          {canEdit ? (
            <button type="button" className="link" aria-label={`Take away ${nameOf(setKey)}`} disabled={isBusy} onClick={() => void save(heldSets.filter((held) => held !== setKey))}>Take away</button>
          ) : null}
        </div>
      ))}

      {canEdit && offered.length > 0 ? (
        <div className="privilege-form-compact">
          <div className="field">
            <label htmlFor={`set-${option.key}`}>Give a permission set</label>
            <select className="input" id={`set-${option.key}`} value={toGive} disabled={isBusy} onChange={(event) => setToGive(event.target.value)}>
              <option value="">Choose a set</option>
              {offered.map((permissionSet) => <option key={permissionSet.key} value={permissionSet.key}>{permissionSet.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`reason-${option.key}`}>Reason (kept in the activity log)</label>
            <input className="input" id={`reason-${option.key}`} autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <div>
            <button type="button" className="btn btn-primary" disabled={isBusy || !toGive} onClick={give}>Give permission set</button>
          </div>
        </div>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
