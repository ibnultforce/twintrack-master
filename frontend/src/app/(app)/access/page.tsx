'use client';

import { useState, type FormEvent } from 'react';
import { Dialog } from '@/components/Dialog';
import { PersonPicker } from '@/components/PersonPicker';
import { Card, Chips, Loaded, Notice, PageHead, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { listProfiles } from '@/lib/api/modules';
import type { AccessModule, AccessProfile, AddablePerson, ModulePerson } from '@/lib/api/types';
import { listAccessModules, listModulePeople, setUserProfile } from '@/lib/api/users';
import { peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

/** Profiles that give something in this module, so giving one adds the person to it. */
const profilesCovering = (profiles: AccessProfile[], moduleKey: string) => profiles.filter((profile) => profile.modules.some((module) => module.key === moduleKey));

function AddPersonForm({ module, profiles, onAdded }: { module: AccessModule; profiles: AccessProfile[]; onAdded: () => void }) {
  const covering = profilesCovering(profiles, module.key);
  const [person, setPerson] = useState<AddablePerson | null>(null);
  const [profileId, setProfileId] = useState(covering[0]?.id ?? '');
  const [error, setError] = useState('');
  const currentProfile = profiles.find((profile) => profile.id === person?.profileId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!person || !profileId) return;
    setError('');
    try {
      await setUserProfile(person.id, profileId);
      onAdded();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  if (covering.length === 0) {
    return <p className="empty">No profile gives access to {module.name} yet. Create one on Profiles, tick what it allows in {module.name}, then give it here.</p>;
  }

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <div className="inline-form">
        <PersonPicker id="add-person" label="Person" moduleKey={module.key} selected={person} onChange={setPerson} />
        <div className="field">
          <label htmlFor="add-profile">Profile</label>
          <select className="input" id="add-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {covering.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!person || !profileId}>Give profile</button>
      </div>
      <p className="note">
        {currentProfile ? `This replaces ${person?.name}'s current profile, ${currentProfile.name}, in every module.` : 'A profile applies in every module, not only this one.'}
        {' '}You can only give a profile within your own access.
      </p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}

/** Changes the one profile a person holds, or takes it away. */
function ProfileChooser({ person, profiles, onChanged }: { person: ModulePerson; profiles: AccessProfile[]; onChanged: () => void }) {
  const [profileId, setProfileId] = useState(person.profile?.id ?? '');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setIsSaving(true);
    try {
      await setUserProfile(person.id, profileId || null);
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void save(event)}>
      <div className="inline-form">
        <div className="field">
          <label htmlFor="change-profile">Profile</label>
          <select className="input" id="change-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">No profile</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={isSaving || profileId === (person.profile?.id ?? '')}>Save profile</button>
      </div>
      <p className="note">The profile applies in every module. You can only give or replace one within your own access.</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}

/** What a person's profile allows in this module, as short labels such as "salary.read (team)". */
const describePermissions = (person: ModulePerson) =>
  Object.entries(person.profilePermissions).map(([permission, scope]) => (scope === 'all' ? permission : `${permission} (${scope})`));

/** Who has access to each module through their profile, and their place in the org tree. */
export default function AccessPage() {
  const viewer = useProfile();
  const { can, canChangeAccess: canGiveProfiles } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const [chosenKey, setChosenKey] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const modules = useLoad(listAccessModules, []);
  const profiles = useLoad(async () => (canReadProfiles ? listProfiles() : []), [canReadProfiles]);
  const module = modules.data?.find((candidate) => candidate.key === chosenKey) ?? modules.data?.[0];
  const people = useLoad(async () => (module ? listModulePeople(module.key) : []), [module?.key], module?.key);

  const editing = people.data?.find((person) => person.id === editingId);
  const reload = () => {
    people.reload();
    profiles.reload();
  };

  return (
    <>
      <PageHead title="Access" subtitle="Who has access to each module, through their profile and role" />
      <Loaded state={modules}>
        {(list) => (module ? (
          <>
            <Chips label="Choose a module" value={module.key} onChange={setChosenKey} options={list.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
            <Loaded state={people}>
              {(moduleList) => (
                <Card title={`People in ${module.name}`} aside={<span className="note">{peopleCount(moduleList.length)}</span>}>
                  {moduleList.length === 0 ? <p className="empty">Nobody has access to {module.name} yet.{canGiveProfiles ? ' Give someone a profile that covers it below.' : ''}</p> : (
                    <div className="table-box">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Person</th>
                            <th scope="col">Role</th>
                            <th scope="col">Profile</th>
                            <th scope="col">Status</th>
                            <th scope="col"><span className="visually-hidden">Change</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {moduleList.map((person) => (
                            <tr key={person.id}>
                              <td><div className="strong">{person.name}</div><div className="meta">{person.email}</div></td>
                              <td>{person.orgRole ? person.orgRole.name : <span className="muted">No role</span>}</td>
                              <td>{person.profile ? person.profile.name : <span className="muted">None</span>}</td>
                              <td><StatusPill status={person.status} /></td>
                              <td>{canGiveProfiles && (person.id !== viewer.id || viewer.superAdmin) ? <button type="button" className="link" aria-label={`Change access for ${person.name}`} onClick={() => setEditingId(person.id)}>Change</button> : null}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
            </Loaded>
            {canGiveProfiles ? (
              <Card title={`Add someone to ${module.name}`}>
                {canReadProfiles ? (
                  <Loaded state={profiles}>
                    {(profileList) => <AddPersonForm key={`${module.key}:${people.data?.length ?? 0}:${profileList.length}`} module={module} profiles={profileList} onAdded={reload} />}
                  </Loaded>
                ) : <p className="empty">Giving a profile here needs accessProfile.read, to list the profiles.</p>}
              </Card>
            ) : null}
          </>
        ) : <section className="card"><p className="empty">No modules are loaded.</p></section>)}
      </Loaded>

      {editing && module ? (
        <Dialog title={`${editing.name} in ${module.name}`} onClose={() => setEditingId(null)}>
          <p className="meta">Role: {editing.orgRole?.name ?? 'No role'}. The role decides whose records their team scope reaches, and is changed on People.</p>
          <p className="meta">In {module.name}: {describePermissions(editing).join(', ') || 'nothing'}.</p>
          {profiles.data ? <ProfileChooser key={editing.profile?.id ?? 'none'} person={editing} profiles={profiles.data} onChanged={reload} /> : null}
          <div className="dialog-actions"><button type="button" className="btn" onClick={() => setEditingId(null)}>Done</button></div>
        </Dialog>
      ) : null}
    </>
  );
}
