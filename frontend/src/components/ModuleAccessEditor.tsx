'use client';

import { useState } from 'react';
import { describeError } from '@/lib/api/http';
import type { AccessOption } from '@/lib/api/types';
import { setUserPrivileges, setUserRole } from '@/lib/api/users';
import { PermissionPicker } from './PermissionPicker';
import { Notice } from './ui';

export interface ModuleAccessHolding {
  role: string | null;
  privileges: string[];
  superAdminGrants: string[];
}

/** One person's role and special privileges in one module. The API enforces every rule, and this only hides what can't work. */
export function ModuleAccessEditor({ option, userId, holding, canEdit, isViewerSuperAdmin, onChanged }: {
  option: AccessOption;
  userId: string;
  holding: ModuleAccessHolding;
  canEdit: boolean;
  isViewerSuperAdmin: boolean;
  onChanged: () => void;
}) {
  const [selectedRole, setSelectedRole] = useState(holding.role ?? '');
  const [newPermissions, setNewPermissions] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  // Only a super admin's request replaces what a super admin gave, so anyone else sends just the module's own privileges.
  const replaceablePermissions = isViewerSuperAdmin ? [...holding.privileges, ...holding.superAdminGrants] : holding.privileges;
  const offered = option.grantable.filter(({ permission }) => !replaceablePermissions.includes(permission));
  const roleLabel = `${option.name} role`;

  const run = async (change: () => Promise<unknown>) => {
    setIsBusy(true);
    setError('');
    try {
      await change();
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsBusy(false);
    }
  };

  const giveSelectedPrivileges = () => {
    if (newPermissions.length === 0) return;
    if (!reason.trim()) {
      setError('Say why this person needs these privileges. It goes in the activity log.');
      return;
    }
    void run(() => setUserPrivileges(userId, option.key, [...replaceablePermissions, ...newPermissions], reason.trim()));
  };

  const removePrivilege = (permission: string) =>
    void run(() => setUserPrivileges(userId, option.key, replaceablePermissions.filter((held) => held !== permission)));

  return (
    <div className="access-module">
      <h3>{option.name}</h3>
      <div className="role-assign">
        <div className="field">
          <label htmlFor={`role-${option.key}`}>{roleLabel}</label>
          <select className="input" id={`role-${option.key}`} value={selectedRole} disabled={!canEdit || isBusy} onChange={(event) => setSelectedRole(event.target.value)}>
            <option value="">No role</option>
            {option.roles.map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}
          </select>
        </div>
        {canEdit ? (
          <button type="button" className="btn" aria-label={`Save ${roleLabel}`} disabled={isBusy || selectedRole === (holding.role ?? '')} onClick={() => void run(() => setUserRole(userId, option.key, selectedRole || null))}>
            Save
          </button>
        ) : null}
      </div>

      {replaceablePermissions.length === 0 && holding.superAdminGrants.length === 0 ? <p className="muted">No special privileges.</p> : null}
      {[...holding.privileges, ...holding.superAdminGrants].map((permission) => (
        <div className="privilege" key={permission}>
          <div>
            <code>{permission}</code>
            {holding.superAdminGrants.includes(permission) ? <div className="meta">Given by a super admin</div> : null}
          </div>
          {canEdit && replaceablePermissions.includes(permission) ? (
            <button type="button" className="link" aria-label={`Remove ${permission}`} disabled={isBusy} onClick={() => removePrivilege(permission)}>Remove</button>
          ) : null}
        </div>
      ))}

      {canEdit && offered.length > 0 ? (
        <div className="privilege-form-compact">
          <PermissionPicker id={`privilege-${option.key}`} label="Give special privileges" options={offered} selected={newPermissions} onChange={setNewPermissions} />
          <div className="field">
            <label htmlFor={`reason-${option.key}`}>Reason (kept in the activity log)</label>
            <input className="input" id={`reason-${option.key}`} autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <div>
            <button type="button" className="btn btn-primary" disabled={isBusy || newPermissions.length === 0} onClick={giveSelectedPrivileges}>
              {newPermissions.length > 1 ? `Give ${newPermissions.length} privileges` : 'Give privilege'}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
