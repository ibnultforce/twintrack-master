'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PasswordLinkResultsDialog } from '@/components/Dialog';
import { PersonFormDialog } from '@/components/PersonFormDialog';
import { PersonPhoto } from '@/components/PersonPhoto';
import { Chips, ContractPill, Loaded, Notice, PageHead, Pagination, Pill, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { listProfiles } from '@/lib/api/modules';
import type { AccessProfile, PasswordLinkResult, User, UserStatus } from '@/lib/api/types';
import { createUser, getNextEmployeeNumber, listUsers, sendPasswordLinks } from '@/lib/api/users';
import { humanize, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 250;

type StatusFilter = 'all' | UserStatus;

function AccessPills({ person, profiles }: { person: User; profiles: AccessProfile[] }) {
  if (person.superAdmin) return <Pill tone="accent">Super admin</Pill>;
  if (!person.profileId) return <span className="muted">No access</span>;
  return <Pill tone="accent">{profiles.find((candidate) => candidate.id === person.profileId)?.name ?? 'Profile'}</Pill>;
}

export default function PeoplePage() {
  const viewer = useProfile();
  const { can } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const canSendLinks = can('user.update');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [isAdding, setIsAdding] = useState(false);
  const [nextNumber, setNextNumber] = useState<number | null>(null);
  const [added, setAdded] = useState<{ name: string; invitationSent: boolean } | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [linkResults, setLinkResults] = useState<PasswordLinkResult[] | null>(null);
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const people = useLoad(async () => {
    const [list, profiles] = await Promise.all([
      listUsers({ page, pageSize: PAGE_SIZE, search, status: status === 'all' ? undefined : status }),
      canReadProfiles ? listProfiles() : Promise.resolve<AccessProfile[]>([]),
    ]);
    return { ...list, profiles };
  }, [page, search, status, canReadProfiles]);

  const changeStatus = (next: StatusFilter) => {
    setStatus(next);
    setPage(1);
  };

  const openAddForm = () => {
    setIsAdding(true);
    setNextNumber(null);
    // Only a preview, so the form opens without waiting for it.
    void getNextEmployeeNumber().then(setNextNumber, () => undefined);
  };

  const toggle = (person: User) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(person.id)) next.delete(person.id);
      else next.set(person.id, person.name);
      return next;
    });
  };

  const sendLinks = async () => {
    setLinkError('');
    try {
      setLinkResults(await sendPasswordLinks([...selected.keys()]));
    } catch (failure) {
      setLinkError(describeError(failure));
    }
  };

  /** People you can't send a link to: yourself, super admins unless you are one, and deactivated people. */
  const canSelect = (person: User) => person.status === 'active' && person.id !== viewer.id && (!person.superAdmin || viewer.superAdmin);

  return (
    <>
      <PageHead
        title="People"
        subtitle={people.data ? peopleCount(people.data.total) : undefined}
        actions={(
          <>
            <input className="input search" type="search" aria-label="Search name, email, title" placeholder="Search name, email, title" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
            {can('user.create') ? <button type="button" className="btn btn-primary" onClick={openAddForm}>+ Add person</button> : null}
          </>
        )}
      />
      <div className="toolbar">
        <Chips label="Filter by status" value={status} onChange={changeStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]} />
      </div>
      {added ? (
        <Notice tone={added.invitationSent ? 'good' : 'warning'}>
          {added.invitationSent
            ? `${added.name} was added and emailed a link to set their password.`
            : `${added.name} was added, but the invitation email couldn't be sent. Select them and send a password link.`}
        </Notice>
      ) : null}
      {selected.size > 0 ? (
        <div className="selection-bar">
          <span>{peopleCount(selected.size)} selected</span>
          <button type="button" className="btn btn-small btn-primary" onClick={() => void sendLinks()}>Email password links</button>
          <button type="button" className="link" onClick={() => setSelected(new Map())}>Clear</button>
        </div>
      ) : null}
      {linkError ? <Notice tone="danger">{linkError}</Notice> : null}
      <Loaded state={people}>
        {({ users, total, profiles }) => (
          <section className="card">
            {users.length === 0 ? <p className="empty">Nobody matches this search.</p> : (
              <>
                <div className="table-box">
                  <table>
                    <thead>
                      <tr>
                        {canSendLinks ? <th scope="col" className="select-cell"><span className="visually-hidden">Select</span></th> : null}
                        <th scope="col">Person</th><th scope="col">No.</th><th scope="col">Job title</th><th scope="col">Department</th><th scope="col">Contract</th><th scope="col">Access</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Details</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((person) => (
                        <tr key={person.id}>
                          {canSendLinks ? (
                            <td className="select-cell">
                              <input type="checkbox" aria-label={`Select ${person.name}`} disabled={!canSelect(person)} checked={selected.has(person.id)} onChange={() => toggle(person)} />
                            </td>
                          ) : null}
                          <td>
                            <div className="person">
                              <PersonPhoto personId={person.id} name={person.name} photoUpdatedAt={person.photoUpdatedAt} online={person.online} />
                              <div><div className="strong">{person.name}</div><div className="meta">{person.email}</div></div>
                            </div>
                          </td>
                          <td>{person.employeeNumber ?? '·'}</td>
                          <td>{person.title ?? '·'}</td>
                          <td>{humanize(person.department)}</td>
                          <td><ContractPill contract={person.contract} /></td>
                          <td><AccessPills person={person} profiles={profiles} /></td>
                          <td>
                            <div className="pills">
                              <StatusPill status={person.status} />
                              {person.lastSignedInAt ? null : <Pill tone="warning">Never signed in</Pill>}
                            </div>
                          </td>
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
          intro={`They'll be emailed a link to set their password.${nextNumber ? ` Their employee number will most likely be ${nextNumber}.` : ''}`}
          onClose={() => setIsAdding(false)}
          onSubmit={async (details) => {
            // A new person has nothing to clear, and the API accepts only values for the optional fields here.
            const provided = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null));
            const result = await createUser(provided);
            setAdded({ name: result.user.name, invitationSent: result.invitationSent });
            people.reload();
          }}
        />
      ) : null}
      {linkResults ? (
        <PasswordLinkResultsDialog
          results={linkResults}
          names={selected}
          onClose={() => {
            setLinkResults(null);
            setSelected(new Map());
          }}
        />
      ) : null}
    </>
  );
}
