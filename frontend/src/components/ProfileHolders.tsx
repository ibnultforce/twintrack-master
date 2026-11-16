'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/Dialog';
import { Card, Loaded, Pill, StatusPill } from '@/components/ui';
import { listProfileHolders, setUserProfile } from '@/lib/api/users';
import type { AccessProfile, ProfileHolder } from '@/lib/api/types';
import { peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

/** The modules a profile reaches, each with how many permissions it gives there. Every holder has exactly this. */
function AccessPills({ profile }: { profile: AccessProfile }) {
  const modules = profile.modules.filter((module) => module.loaded);
  if (modules.length === 0) return <span className="muted">Nothing yet</span>;
  return (
    <div className="pills">
      {modules.map((module) => (
        <span key={module.key} title={module.grants.join('\n')}>
          <Pill tone="accent">{module.name} · {module.grants.length}</Pill>
        </span>
      ))}
    </div>
  );
}

/**
 * Who holds a profile, what it gives them, and a Remove button where the viewer may take it away. Removing leaves the
 * person with no profile, so no access, from their next request.
 */
export function ProfileHolders({ profile, onChanged }: { profile: AccessProfile; onChanged: () => void }) {
  const holders = useLoad(() => listProfileHolders(profile.id), [profile.id, profile.holders]);
  const [removing, setRemoving] = useState<ProfileHolder | null>(null);

  return (
    <Loaded state={holders}>
      {(people) => (
        <Card title={`People with ${profile.name}`} aside={<span className="note">{peopleCount(people.length)}</span>}>
          {people.length === 0 ? <p className="empty">Nobody holds {profile.name}{profile.holders > 0 ? ' that your access reaches' : ''}.</p> : (
            <div className="table-box">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Access</th>
                    <th scope="col"><span className="visually-hidden">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.id}>
                      <td><div className="strong">{person.name}</div><div className="meta">{person.email}</div></td>
                      <td>{person.orgRole ? person.orgRole.name : <span className="muted">No role</span>}</td>
                      <td><StatusPill status={person.status} /></td>
                      <td><AccessPills profile={profile} /></td>
                      <td>{person.canRemove ? <button type="button" className="link" aria-label={`Remove ${profile.name} from ${person.name}`} onClick={() => setRemoving(person)}>Remove</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note spaced">Everyone here has what {profile.name} allows. Hover a module to see its permissions.</p>
          {removing ? (
            <ConfirmDialog
              title={`Remove ${profile.name} from ${removing.name}?`}
              text={`${removing.name} will have no profile, so no access to any module, from their next request. You can give them a profile again on Access.`}
              confirmLabel="Remove"
              isDanger
              onClose={() => setRemoving(null)}
              onConfirm={async () => { await setUserProfile(removing.id, null); onChanged(); }}
            />
          ) : null}
        </Card>
      )}
    </Loaded>
  );
}
