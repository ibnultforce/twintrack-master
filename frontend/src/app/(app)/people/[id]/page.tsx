'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog, TemporaryPasswordDialog } from '@/components/Dialog';
import { ModuleAccessEditor } from '@/components/ModuleAccessEditor';
import { PersonFormDialog } from '@/components/PersonFormDialog';
import { Card, ContractPill, Loaded, Notice, PageHead, Pill, Row, StatusPill } from '@/components/ui';
import { listRoles } from '@/lib/api/modules';
import type { AccessOption, RoleTemplate, Scope, TemporaryPasswordResult, User } from '@/lib/api/types';
import { getAccessOptions, getUser, resetUserPassword, setUserStatus, updateUser } from '@/lib/api/users';
import { humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { isWiderScope } from '@/lib/roleGrants';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

interface EffectivePermission {
  permission: string;
  scope?: Scope;
  source: string;
  isSpecial: boolean;
}

function effectivePermissions(person: User, option: AccessOption, roles: RoleTemplate[]): EffectivePermission[] {
  const held = new Map<string, EffectivePermission>();
  const role = roles.find((candidate) => candidate.module === option.key && candidate.key === person.assignments[option.key]);
  for (const [permission, scope] of Object.entries(role?.permissions ?? {})) held.set(permission, { permission, scope, source: role!.name, isSpecial: false });

  for (const permission of [...(person.privileges[option.key] ?? []), ...(person.superAdminGrants[option.key] ?? [])]) {
    const scope = option.grantable.find((candidate) => candidate.permission === permission)?.scope;
    const existing = held.get(permission);
    if (!existing || (scope && existing.scope && isWiderScope(scope, existing.scope))) held.set(permission, { permission, scope, source: 'Special privilege', isSpecial: true });
  }
  return [...held.values()];
}

function WhatTheyCanDo({ person, options, roles }: { person: User; options: AccessOption[]; roles: RoleTemplate[] }) {
  if (person.superAdmin) return <p className="muted">They have every permission in every module, as a super admin.</p>;
  return (
    <>
      {options.map((option) => {
        const permissions = effectivePermissions(person, option, roles);
        return (
          <div className="module-access" key={option.key}>
            <h3>{option.name}</h3>
            {permissions.length === 0 ? <p className="muted">No access.</p> : (
              <div className="table-box">
                <table>
                  <thead><tr><th scope="col">Permission</th><th scope="col">Applies to</th><th scope="col">Comes from</th></tr></thead>
                  <tbody>
                    {permissions.map((item) => (
                      <tr key={item.permission}>
                        <td><code>{item.permission}</code></td>
                        <td>{item.scope ? SCOPE_LABELS[item.scope] : '·'}</td>
                        <td>{item.isSpecial ? <Pill tone="warning">{item.source}</Pill> : item.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      <p className="note spaced">{SCOPE_LEGEND}</p>
    </>
  );
}

type OpenDialog = 'edit' | 'status' | 'reset' | null;

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const viewer = useProfile();
  const { can, refreshSession } = useSession();
  const canReadRoles = can('role.read');
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [temporary, setTemporary] = useState<TemporaryPasswordResult | null>(null);

  const details = useLoad(async () => {
    const [person, options, roles] = await Promise.all([getUser(id), getAccessOptions(), canReadRoles ? listRoles() : Promise.resolve(null)]);
    return { person, options, roles };
  }, [id, canReadRoles]);

  const afterAccessChange = () => {
    details.reload();
    if (id === viewer.id) void refreshSession();
  };

  return (
    <>
      <Link className="back" href="/people">← People</Link>
      <Loaded state={details}>
        {({ person, options, roles }) => {
          const isSelf = person.id === viewer.id;
          const canManageAccount = can('user.update') && (!person.superAdmin || viewer.superAdmin);
          const canEditModule = (option: AccessOption) => option.canChange && !person.superAdmin && (!isSelf || viewer.superAdmin);

          let explanation = 'Roles come from each module. Special privileges add one permission without changing the role.';
          if (person.superAdmin) explanation = 'A super admin already has every permission.';
          else if (isSelf && !viewer.superAdmin) explanation = 'Nobody can change their own access. Ask another admin.';
          else if (!options.some((option) => option.canChange)) explanation = 'Your role can read access, but not change it.';

          return (
            <>
              <PageHead title={person.name} subtitle={person.email} />
              <div className="pair">
                <div className="stack">
                  <Card title="Details" aside={canManageAccount ? <button type="button" className="link" onClick={() => setDialog('edit')}>Edit</button> : undefined}>
                    <Row label="Job title">{person.title ?? '·'}</Row>
                    <Row label="Department">{humanize(person.department)}</Row>
                    <Row label="Team">{humanize(person.team)}</Row>
                    <Row label="Contract"><ContractPill contract={person.contract} /></Row>
                  </Card>
                  <Card title="Account">
                    <Row label="Status"><StatusPill status={person.status} /></Row>
                    <Row label="Password">{person.mustChangePassword ? 'Temporary, waiting to be changed' : 'Set by this person'}</Row>
                    {canManageAccount && !isSelf ? (
                      <div className="actions">
                        <button type="button" className="btn" onClick={() => setDialog('reset')}>Reset password</button>
                        <button type="button" className={`btn ${person.status === 'active' ? 'btn-danger' : ''}`} onClick={() => setDialog('status')}>{person.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
                      </div>
                    ) : null}
                  </Card>
                </div>
                <Card title="Access in each module" aside={<span className="note">One role per module</span>}>
                  <p className="note">{explanation}</p>
                  {person.superAdmin ? null : options.map((option) => (
                    <ModuleAccessEditor
                      key={`${option.key}:${person.assignments[option.key] ?? ''}:${(person.privileges[option.key] ?? []).join()}:${(person.superAdminGrants[option.key] ?? []).join()}`}
                      option={option}
                      userId={person.id}
                      holding={{ role: person.assignments[option.key] ?? null, privileges: person.privileges[option.key] ?? [], superAdminGrants: person.superAdminGrants[option.key] ?? [] }}
                      canEdit={canEditModule(option)}
                      isViewerSuperAdmin={viewer.superAdmin}
                      onChanged={afterAccessChange}
                    />
                  ))}
                </Card>
              </div>
              {roles ? (
                <Card title="What they can do">
                  {person.status === 'inactive' ? <Notice tone="warning">This account is deactivated, so none of this applies until it is reactivated.</Notice> : null}
                  <WhatTheyCanDo person={person} options={options} roles={roles} />
                </Card>
              ) : null}

              {dialog === 'edit' ? (
                <PersonFormDialog title={`Edit ${person.name}`} submitLabel="Save" person={person} onClose={() => setDialog(null)} onSubmit={async (changes) => { await updateUser(person.id, changes); details.reload(); }} />
              ) : null}
              {dialog === 'status' ? (
                <ConfirmDialog
                  title={person.status === 'active' ? `Deactivate ${person.name}?` : `Reactivate ${person.name}?`}
                  text={person.status === 'active' ? 'They will be signed out everywhere and won\'t be able to sign in.' : 'They will be able to sign in again.'}
                  confirmLabel={person.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  isDanger={person.status === 'active'}
                  onClose={() => setDialog(null)}
                  onConfirm={async () => { await setUserStatus(person.id, person.status === 'active' ? 'inactive' : 'active'); details.reload(); }}
                />
              ) : null}
              {dialog === 'reset' ? (
                <ConfirmDialog
                  title={`Reset ${person.name}'s password?`}
                  text="They will be signed out everywhere and must choose a new password."
                  confirmLabel="Reset password"
                  onClose={() => setDialog(null)}
                  onConfirm={async () => { setTemporary(await resetUserPassword(person.id)); details.reload(); }}
                />
              ) : null}
              {temporary ? <TemporaryPasswordDialog name={temporary.user.name} password={temporary.temporaryPassword} onClose={() => setTemporary(null)} /> : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
