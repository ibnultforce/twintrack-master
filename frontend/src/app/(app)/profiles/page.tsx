'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { GrantsMatrix } from '@/components/GrantsMatrix';
import { Card, Chips, Loaded, Notice, PageHead } from '@/components/ui';
import { getMyModuleAccess } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';
import { createProfile, listModules, listProfiles, removeProfile, updateProfile } from '@/lib/api/modules';
import type { AccessProfile, FieldAccessMap, Grants, PermissionMap, RegisteredModule } from '@/lib/api/types';
import { peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

function ProfileNameDialog({ title, submitLabel, profile, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  profile?: AccessProfile;
  onSubmit: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await onSubmit(name.trim(), description.trim());
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="field"><label htmlFor="profile-name">Name</label><input className="input" id="profile-name" autoComplete="off" required value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="profile-description">Who is this profile for?</label><input className="input" id="profile-description" autoComplete="off" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

interface Assignable {
  permissions: PermissionMap | null;
  fields: FieldAccessMap | null;
}

/** What this person may put in a profile in each module. A super admin may put anything, shown as null. */
async function loadAssignable(isSuperAdmin: boolean, modules: RegisteredModule[]): Promise<Record<string, Assignable>> {
  if (isSuperAdmin) return Object.fromEntries(modules.map((module) => [module.key, { permissions: null, fields: null }]));
  const access = await Promise.all(modules.map((module) => getMyModuleAccess(module.key)));
  return Object.fromEntries(modules.map((module, index) => [module.key, { permissions: access[index]!.permissions, fields: access[index]!.fieldAccess }]));
}

type ProfileDialog = 'new' | 'edit' | 'delete' | null;

export default function ProfilesPage() {
  const viewer = useProfile();
  const { can } = useSession();
  const canCreate = can('accessProfile.create');
  const canUpdate = can('accessProfile.update');
  const canDelete = can('accessProfile.delete');
  const canReadModules = can('module.read');

  const data = useLoad(async () => {
    const [profiles, modules] = await Promise.all([listProfiles(), canReadModules ? listModules() : Promise.resolve<RegisteredModule[]>([])]);
    return { profiles, modules, assignable: await loadAssignable(viewer.superAdmin, modules) };
  }, [canReadModules, viewer.superAdmin]);
  const [profileId, setProfileId] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [dialog, setDialog] = useState<ProfileDialog>(null);

  return (
    <>
      <PageHead title="Profiles" subtitle="Each person's baseline access across every module. Permission sets add to it." />
      <Loaded state={data}>
        {({ profiles, modules, assignable }) => {
          const profile = profiles.find((candidate) => candidate.id === profileId) ?? profiles[0];
          const module = modules.find((candidate) => candidate.key === moduleKey) ?? modules[0];
          const part = profile && module ? profile.modules.find((candidate) => candidate.key === module.key) : undefined;

          const saveGrants = async (grants: Grants) => {
            if (!profile || !module) return;
            const others = Object.fromEntries(Object.entries(profile.grants).filter(([key]) => key !== module.key));
            await updateProfile(profile.id, { grants: Object.keys(grants).length > 0 ? { ...others, [module.key]: grants } : others });
            data.reload();
          };

          return (
            <>
              <div className="split">
                <section className="side" aria-label="Profiles">
                  <div className="side-head">
                    <span>Profiles</span>
                    {canCreate ? <button type="button" className="link" onClick={() => setDialog('new')}>+ New profile</button> : null}
                  </div>
                  {profiles.length === 0 ? <p className="muted side-empty">No profiles yet.</p> : null}
                  {profiles.map((candidate) => (
                    <button type="button" key={candidate.id} className="item item-button" aria-current={candidate.id === profile?.id} onClick={() => setProfileId(candidate.id)}>
                      <b>{candidate.name}</b>
                      <span className="count">{candidate.holders}</span>
                      <small>{candidate.description || 'No description'}</small>
                    </button>
                  ))}
                </section>
                <div className="pane">
                  {profile ? (
                    <>
                      <section className="card pane-top">
                        <div className="pane-row">
                          <div><h2>{profile.name}</h2><p className="muted">{profile.description || 'No description'} · {peopleCount(profile.holders)}</p></div>
                          {canUpdate || canDelete ? (
                            <div className="page-actions">
                              {canUpdate ? <button type="button" className="btn" onClick={() => setDialog('edit')}>Edit name</button> : null}
                              {canDelete ? <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button> : null}
                            </div>
                          ) : null}
                        </div>
                      </section>
                      {module ? (
                        <>
                          <Chips label="Choose a module" value={module.key} onChange={setModuleKey} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
                          <Card title={`What ${profile.name} allows in ${module.name}`} aside={<span className="note">Changes apply on each holder&apos;s next request</span>}>
                            {profile.grants[module.key] === '*' ? <p className="explain">This profile holds everything in {module.name}. Saving here turns it into a fixed list.</p> : null}
                            <GrantsMatrix
                              key={`${profile.id}:${module.key}`}
                              moduleKey={module.key}
                              permissions={part?.permissions ?? {}}
                              fieldAccess={part?.fieldAccess ?? {}}
                              resources={module.resources}
                              apis={module.apis}
                              canEdit={canUpdate}
                              assignable={assignable[module.key]?.permissions ?? null}
                              assignableFields={assignable[module.key]?.fields ?? null}
                              onSave={saveGrants}
                            />
                          </Card>
                        </>
                      ) : (
                        <Card title="What this profile allows">
                          {profile.modules.length === 0 ? <p className="empty">Nothing yet.</p> : profile.modules.map((candidate) => (
                            <div className="module-access" key={candidate.key}><h3>{candidate.name}</h3><ul className="field-list">{candidate.grants.map((grant) => <li key={grant}><code>{grant}</code></li>)}</ul></div>
                          ))}
                          <p className="note spaced">Editing what a profile allows also needs module.read, to show each module&apos;s permissions.</p>
                        </Card>
                      )}
                    </>
                  ) : <section className="card"><p className="empty">No profiles yet.{canCreate ? ' Select + New profile to create the first one.' : ''}</p></section>}
                </div>
              </div>

              {dialog === 'new' ? <ProfileNameDialog title="New profile" submitLabel="Add profile" onClose={() => setDialog(null)} onSubmit={async (name, description) => { const created = await createProfile({ name, description: description || undefined, grants: {} }); setProfileId(created.id); data.reload(); }} /> : null}
              {dialog === 'edit' && profile ? <ProfileNameDialog title={`Edit ${profile.name}`} submitLabel="Save" profile={profile} onClose={() => setDialog(null)} onSubmit={async (name, description) => { await updateProfile(profile.id, { name, description: description || null }); data.reload(); }} /> : null}
              {dialog === 'delete' && profile ? <ConfirmDialog title={`Delete ${profile.name}?`} text="A profile someone still holds can't be deleted." confirmLabel="Delete" isDanger onClose={() => setDialog(null)} onConfirm={async () => { await removeProfile(profile.id); setProfileId(''); data.reload(); }} /> : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
