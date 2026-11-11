'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog, PasswordLinkResultsDialog } from '@/components/Dialog';
import { PersonFormDialog } from '@/components/PersonFormDialog';
import { PhotoEditor } from '@/components/PhotoEditor';
import { Card, ContractPill, Loaded, Notice, PageHead, Pill, Row, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { listOrgRoles, listProfiles } from '@/lib/api/modules';
import type { AccessModule, AccessProfile, OrgRole, PasswordLinkResult, User } from '@/lib/api/types';
import { deleteUser, getUser, listAccessModules, sendPasswordLinks, setUserProfile, setUserStatus, updateUser } from '@/lib/api/users';
import { formatTime, humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

function WhatTheyCanDo({ person, modules, profile }: { person: User; modules: AccessModule[]; profile: AccessProfile | undefined }) {
  if (person.superAdmin) return <p className="muted">They have every permission in every module, as a super admin.</p>;
  return (
    <>
      {modules.map((module) => {
        const permissions = Object.entries(profile?.modules.find((part) => part.key === module.key)?.permissions ?? {});
        return (
          <div className="module-access" key={module.key}>
            <h3>{module.name}</h3>
            {permissions.length === 0 ? <p className="muted">No access.</p> : (
              <div className="table-box">
                <table>
                  <thead><tr><th scope="col">Permission</th><th scope="col">Applies to</th></tr></thead>
                  <tbody>
                    {permissions.map(([permission, scope]) => (
                      <tr key={permission}>
                        <td><code>{permission}</code></td>
                        <td>{SCOPE_LABELS[scope]}</td>
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

/** Picks the person's one profile. Needs userProfile.update, and the API keeps it within the giver's own access and reach. */
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

type OpenDialog = 'edit' | 'status' | 'reset' | 'delete' | 'impersonate' | null;

function OnlineStatus({ online }: { online?: boolean }) {
  if (online === undefined) return <span className="muted">Not shown to you</span>;
  return online ? <Pill tone="good">Online</Pill> : <span>Offline</span>;
}

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const viewer = useProfile();
  const router = useRouter();
  const { can, canChangeAccess: canGiveProfiles, refreshSession, startImpersonating } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const canReadOrgRoles = can('orgRole.read');
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [linkResults, setLinkResults] = useState<PasswordLinkResult[] | null>(null);

  const details = useLoad(async () => {
    const [person, modules, profiles, orgRoles] = await Promise.all([
      getUser(id),
      listAccessModules(),
      canReadProfiles ? listProfiles() : Promise.resolve(null),
      canReadOrgRoles ? listOrgRoles() : Promise.resolve(null),
    ]);
    return { person, modules, profiles, orgRoles };
  }, [id, canReadProfiles, canReadOrgRoles]);

  const afterAccessChange = () => {
    details.reload();
    if (id === viewer.id) void refreshSession();
  };

  return (
    <>
      <Link className="back" href="/people">← People</Link>
      <Loaded state={details}>
        {({ person, modules, profiles, orgRoles }) => {
          const isSelf = person.id === viewer.id;
          const canManageAccount = can('user.update') && (!person.superAdmin || viewer.superAdmin);
          const canChangePhoto = isSelf || canManageAccount;
          const hasNeverSignedIn = !person.lastSignedInAt;
          const canDelete = can('user.delete') && hasNeverSignedIn && !isSelf && (!person.superAdmin || viewer.superAdmin);
          const canImpersonate = viewer.canImpersonate && !isSelf && !person.superAdmin && person.status === 'active';
          const canChangeProfile = canGiveProfiles && !person.superAdmin && (!isSelf || viewer.superAdmin);
          const profile = profiles?.find((candidate) => candidate.id === person.profileId);

          let explanation = 'Their profile decides everything they can do, in every module.';
          if (person.superAdmin) explanation = 'A super admin already has every permission.';
          else if (isSelf && !viewer.superAdmin) explanation = 'Nobody can change their own access. Ask another admin.';
          else if (!canChangeProfile) explanation = 'You can read this access, but not change it.';

          return (
            <>
              <PageHead
                title={person.name}
                subtitle={person.employeeNumber ? `${person.email} · No. ${person.employeeNumber}` : person.email}
                actions={canImpersonate ? <button type="button" className="btn" onClick={() => setDialog('impersonate')}>Log in as {person.name.split(' ')[0]}</button> : undefined}
              />
              <div className="pair">
                <div className="stack">
                  <Card title="Details" aside={canManageAccount ? <button type="button" className="link" onClick={() => setDialog('edit')}>Edit</button> : undefined}>
                    <PhotoEditor personId={person.id} name={person.name} photoUpdatedAt={person.photoUpdatedAt} online={person.online} canChange={canChangePhoto} onChanged={afterAccessChange} />
                    <Row label="Employee number">{person.employeeNumber ?? '·'}</Row>
                    <Row label="Job title">{person.title ?? '·'}</Row>
                    <Row label="Department">{humanize(person.department)}</Row>
                    <Row label="Team">{humanize(person.team)}</Row>
                    <Row label="Contract"><ContractPill contract={person.contract} /></Row>
                    <Row label="Org role">{describeOrgRole(orgRoles, person.orgRoleId)}</Row>
                  </Card>
                  <Card title="Account">
                    <Row label="Status"><StatusPill status={person.status} /></Row>
                    <Row label="Online"><OnlineStatus online={person.online} /></Row>
                    <Row label="Last signed in">{person.lastSignedInAt ? formatTime(person.lastSignedInAt) : 'Never. Their account is waiting to be set up'}</Row>
                    {canManageAccount && !isSelf ? (
                      <div className="actions">
                        {person.status === 'active' ? (
                          <button type="button" className="btn" onClick={() => setDialog('reset')}>{hasNeverSignedIn ? 'Resend invitation' : 'Email a password link'}</button>
                        ) : null}
                        <button type="button" className={`btn ${person.status === 'active' ? 'btn-danger' : ''}`} onClick={() => setDialog('status')}>{person.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
                        {canDelete ? <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button> : null}
                      </div>
                    ) : null}
                  </Card>
                </div>
                <Card title="Access" aside={<span className="note">One profile for every module</span>}>
                  <p className="note">{explanation}</p>
                  {person.superAdmin ? null : (
                    <>
                      {profiles ? (
                        <ProfileChooser key={person.profileId ?? ''} person={person} profiles={profiles} canChange={canChangeProfile} onChanged={afterAccessChange} />
                      ) : <Row label="Profile">{person.profileId ? 'Set, but you can\'t read profiles' : 'No profile'}</Row>}
                    </>
                  )}
                </Card>
              </div>
              <Card title="What they can do">
                {person.status === 'inactive' ? <Notice tone="warning">This account is deactivated, so none of this applies until it is reactivated.</Notice> : null}
                {person.profileId && !profiles ? <Notice tone="warning">Their profile isn&apos;t shown, because reading profiles needs accessProfile.read.</Notice> : null}
                <WhatTheyCanDo person={person} modules={modules} profile={profile} />
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
                  title={`Email ${person.name} a password link?`}
                  text={`They'll get a one-time link at ${person.email} to set a new password. Their current password keeps working until they use it, and then every session they have is signed out.`}
                  confirmLabel="Send link"
                  onClose={() => setDialog(null)}
                  onConfirm={async () => setLinkResults(await sendPasswordLinks([person.id]))}
                />
              ) : null}
              {linkResults ? <PasswordLinkResultsDialog results={linkResults} names={new Map([[person.id, person.name]])} onClose={() => setLinkResults(null)} /> : null}
              {dialog === 'delete' ? (
                <ConfirmDialog
                  title={`Delete ${person.name}?`}
                  text="They have never signed in, so they can be removed completely. This can't be undone. Anyone who has signed in can only be deactivated."
                  confirmLabel="Delete"
                  isDanger
                  onClose={() => setDialog(null)}
                  onConfirm={async () => { await deleteUser(person.id); router.replace('/people'); }}
                />
              ) : null}
              {dialog === 'impersonate' ? (
                <ConfirmDialog
                  title={`Log in as ${person.name}?`}
                  text="You'll see exactly what their access shows them, until you stop or about 15 minutes pass. You can't change their password or make tokens for them. Development only, and logged."
                  confirmLabel="Log in as them"
                  onClose={() => setDialog(null)}
                  onConfirm={async () => { await startImpersonating(person.id); router.replace('/modules'); }}
                />
              ) : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
