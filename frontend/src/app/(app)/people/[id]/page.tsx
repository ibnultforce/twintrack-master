'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog, TemporaryPasswordDialog } from '@/components/Dialog';
import { ModuleAccessEditor } from '@/components/ModuleAccessEditor';
import { PersonFormDialog } from '@/components/PersonFormDialog';
import { Card, ContractPill, Loaded, Notice, PageHead, Pill, Row, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { listOrgRoles, listProfiles } from '@/lib/api/modules';
import type { AccessOption, AccessProfile, OrgRole, Scope, TemporaryPasswordResult, User } from '@/lib/api/types';
import { getAccessOptions, getUser, resetUserPassword, setUserProfile, setUserStatus, updateUser } from '@/lib/api/users';
import { humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { isWiderScope } from '@/lib/grants';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

interface EffectivePermission {
  permission: string;
  scope: Scope;
  sources: string[];
}

/** Where each permission in one module comes from: the profile, any permission sets, or both. The widest scope wins. */
function effectivePermissions(person: User, option: AccessOption, profile: AccessProfile | undefined): EffectivePermission[] {
  const held = new Map<string, EffectivePermission>();
  const add = (permissions: Record<string, Scope>, source: string) => {
    for (const [permission, scope] of Object.entries(permissions)) {
      const existing = held.get(permission);
      if (!existing) held.set(permission, { permission, scope, sources: [source] });
      else held.set(permission, { permission, scope: isWiderScope(scope, existing.scope) ? scope : existing.scope, sources: [...existing.sources, source] });
    }
  };
  const profilePart = profile?.modules.find((module) => module.key === option.key);
  if (profile && profilePart) add(profilePart.permissions, `Profile ${profile.name}`);
  for (const setKey of person.permissionSets[option.key] ?? []) {
    const permissionSet = option.permissionSets.find((candidate) => candidate.key === setKey);
    if (permissionSet) add(permissionSet.permissions, permissionSet.name);
  }
  return [...held.values()];
}

function WhatTheyCanDo({ person, options, profile }: { person: User; options: AccessOption[]; profile: AccessProfile | undefined }) {
  if (person.superAdmin) return <p className="muted">They have every permission in every module, as a super admin.</p>;
  return (
    <>
      {options.map((option) => {
        const permissions = effectivePermissions(person, option, profile);
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
                        <td>{SCOPE_LABELS[item.scope]}</td>
                        <td>{item.sources.map((source) => <Pill key={source} tone={source.startsWith('Profile ') ? 'accent' : 'neutral'}>{source}</Pill>)}</td>
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

/** Picks the person's one profile. Only Master admins with user.update can change it. */
function ProfileChooser({ person, profiles, canChange, onChanged }: { person: User; profiles: AccessProfile[]; canChange: boolean; onChanged: () => void }) {
  const [chosen, setChosen] = useState(person.profileId ?? '');
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try {
      await setUserProfile(person.id, chosen || null);
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    }
  };
  return (
    <>
      <div className="role-assign">
        <div className="field">
          <label htmlFor="person-profile">Profile</label>
          <select className="input" id="person-profile" value={chosen} disabled={!canChange} onChange={(event) => setChosen(event.target.value)}>
            <option value="">No profile</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </div>
        {canChange ? <button type="button" className="btn" disabled={chosen === (person.profileId ?? '')} onClick={() => void save()}>Save</button> : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </>
  );
}

const describeOrgRole = (orgRoles: OrgRole[] | null, orgRoleId?: string) => {
  if (!orgRoleId) return 'Not placed yet';
  return orgRoles?.find((orgRole) => orgRole.id === orgRoleId)?.name ?? orgRoleId;
};

type OpenDialog = 'edit' | 'status' | 'reset' | null;

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const viewer = useProfile();
  const { can, refreshSession } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const canReadOrgRoles = can('orgRole.read');
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [temporary, setTemporary] = useState<TemporaryPasswordResult | null>(null);

  const details = useLoad(async () => {
    const [person, options, profiles, orgRoles] = await Promise.all([
      getUser(id),
      getAccessOptions(),
      canReadProfiles ? listProfiles() : Promise.resolve(null),
      canReadOrgRoles ? listOrgRoles() : Promise.resolve(null),
    ]);
    return { person, options, profiles, orgRoles };
  }, [id, canReadProfiles, canReadOrgRoles]);

  const afterAccessChange = () => {
    details.reload();
    if (id === viewer.id) void refreshSession();
  };

  return (
    <>
      <Link className="back" href="/people">← People</Link>
      <Loaded state={details}>
        {({ person, options, profiles, orgRoles }) => {
          const isSelf = person.id === viewer.id;
          const canManageAccount = can('user.update') && (!person.superAdmin || viewer.superAdmin);
          const canChangeProfile = canManageAccount && !person.superAdmin && (!isSelf || viewer.superAdmin);
          const canEditModule = (option: AccessOption) => option.canChange && !person.superAdmin && (!isSelf || viewer.superAdmin);
          const profile = profiles?.find((candidate) => candidate.id === person.profileId);

          let explanation = 'The profile sets their baseline in every module. Permission sets add to it, one module at a time.';
          if (person.superAdmin) explanation = 'A super admin already has every permission.';
          else if (isSelf && !viewer.superAdmin) explanation = 'Nobody can change their own access. Ask another admin.';
          else if (!canChangeProfile && !options.some((option) => option.canChange)) explanation = 'You can read this access, but not change it.';

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
                    <Row label="Org role">{describeOrgRole(orgRoles, person.orgRoleId)}</Row>
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
                <Card title="Access" aside={<span className="note">One profile, any number of permission sets</span>}>
                  <p className="note">{explanation}</p>
                  {person.superAdmin ? null : (
                    <>
                      {profiles ? (
                        <ProfileChooser key={person.profileId ?? ''} person={person} profiles={profiles} canChange={canChangeProfile} onChanged={afterAccessChange} />
                      ) : <Row label="Profile">{person.profileId ? 'Set, but you can\'t read profiles' : 'No profile'}</Row>}
                      {options.map((option) => (
                        <ModuleAccessEditor
                          key={`${option.key}:${(person.permissionSets[option.key] ?? []).join()}`}
                          option={option}
                          userId={person.id}
                          heldSets={person.permissionSets[option.key] ?? []}
                          profileGrants={profile?.modules.find((module) => module.key === option.key)?.grants ?? []}
                          canEdit={canEditModule(option)}
                          onChanged={afterAccessChange}
                        />
                      ))}
                    </>
                  )}
                </Card>
              </div>
              <Card title="What they can do">
                {person.status === 'inactive' ? <Notice tone="warning">This account is deactivated, so none of this applies until it is reactivated.</Notice> : null}
                {person.profileId && !profiles ? <Notice tone="warning">Their profile isn&apos;t shown, because reading profiles needs accessProfile.read.</Notice> : null}
                <WhatTheyCanDo person={person} options={options} profile={profile} />
              </Card>

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
