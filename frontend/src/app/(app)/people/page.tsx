'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TemporaryPasswordDialog } from '@/components/Dialog';
import { PersonFormDialog } from '@/components/PersonFormDialog';
import { Avatar, Chips, ContractPill, Loaded, PageHead, Pagination, Pill, StatusPill } from '@/components/ui';
import { listProfiles } from '@/lib/api/modules';
import type { AccessOption, AccessProfile, TemporaryPasswordResult, User, UserStatus } from '@/lib/api/types';
import { createUser, getAccessOptions, listUsers } from '@/lib/api/users';
import { humanize, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 250;

type StatusFilter = 'all' | UserStatus;

function AccessPills({ person, modules, profiles }: { person: User; modules: AccessOption[]; profiles: AccessProfile[] }) {
  if (person.superAdmin) return <Pill tone="accent">Super admin</Pill>;
  const profile = profiles.find((candidate) => candidate.id === person.profileId);
  const sets = modules.flatMap((module) =>
    (person.permissionSets[module.key] ?? []).map((setKey) => `${module.name}: ${module.permissionSets.find((permissionSet) => permissionSet.key === setKey)?.name ?? setKey}`),
  );
  if (!person.profileId && sets.length === 0) return <span className="muted">No access</span>;
  return (
    <div className="pills">
      {person.profileId ? <Pill tone="accent">{profile?.name ?? 'Profile'}</Pill> : null}
      {sets.map((label) => <Pill tone="neutral" key={label}>{label}</Pill>)}
    </div>
  );
}

export default function PeoplePage() {
  const { can } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [isAdding, setIsAdding] = useState(false);
  const [created, setCreated] = useState<TemporaryPasswordResult | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const people = useLoad(async () => {
    const [list, modules, profiles] = await Promise.all([
      listUsers({ page, pageSize: PAGE_SIZE, search, status: status === 'all' ? undefined : status }),
      getAccessOptions(),
      canReadProfiles ? listProfiles() : Promise.resolve<AccessProfile[]>([]),
    ]);
    return { ...list, modules, profiles };
  }, [page, search, status, canReadProfiles]);

  const changeStatus = (next: StatusFilter) => {
    setStatus(next);
    setPage(1);
  };

  return (
    <>
      <PageHead
        title="People"
        subtitle={people.data ? peopleCount(people.data.total) : undefined}
        actions={(
          <>
            <input className="input search" type="search" aria-label="Search name, email, title" placeholder="Search name, email, title" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
            {can('user.create') ? <button type="button" className="btn btn-primary" onClick={() => setIsAdding(true)}>+ Add person</button> : null}
          </>
        )}
      />
      <div className="toolbar">
        <Chips label="Filter by status" value={status} onChange={changeStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]} />
      </div>
      <Loaded state={people}>
        {({ users, total, modules, profiles }) => (
          <section className="card">
            {users.length === 0 ? <p className="empty">Nobody matches this search.</p> : (
              <>
                <div className="table-box">
                  <table>
                    <thead>
                      <tr><th scope="col">Person</th><th scope="col">Job title</th><th scope="col">Department</th><th scope="col">Contract</th><th scope="col">Access</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Details</span></th></tr>
                    </thead>
                    <tbody>
                      {users.map((person) => (
                        <tr key={person.id}>
                          <td><div className="person"><Avatar name={person.name} /><div><div className="strong">{person.name}</div><div className="meta">{person.email}</div></div></div></td>
                          <td>{person.title ?? '·'}</td>
                          <td>{humanize(person.department)}</td>
                          <td><ContractPill contract={person.contract} /></td>
                          <td><AccessPills person={person} modules={modules} profiles={profiles} /></td>
                          <td><StatusPill status={person.status} /></td>
                          <td><Link className="link" href={`/people/${encodeURIComponent(person.id)}`} aria-label={`Details for ${person.name}`}>Details</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
              </>
            )}
          </section>
        )}
      </Loaded>

      {isAdding ? (
        <PersonFormDialog
          title="Add a person"
          submitLabel="Add person"
          onClose={() => setIsAdding(false)}
          onSubmit={async (details) => {
            // A new person has nothing to clear, and the API accepts only values for the optional fields here.
            const provided = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null));
            setCreated(await createUser(provided));
            people.reload();
          }}
        />
      ) : null}
      {created ? <TemporaryPasswordDialog name={created.user.name} password={created.temporaryPassword} onClose={() => setCreated(null)} /> : null}
    </>
  );
}
