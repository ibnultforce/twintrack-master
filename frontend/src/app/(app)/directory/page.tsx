'use client';

import { useEffect, useState } from 'react';
import { PersonPhoto } from '@/components/PersonPhoto';
import { Loaded, PageHead, Pagination } from '@/components/ui';
import { listDirectory } from '@/lib/api/account';
import { humanize, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 250;

/** Everyone signed in can look colleagues up. Online status shows only where the viewer's access reaches. */
export default function DirectoryPage() {
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const directory = useLoad(() => listDirectory({ page, pageSize: PAGE_SIZE, search }), [page, search]);

  return (
    <>
      <PageHead
        title="Directory"
        subtitle={directory.data ? `${peopleCount(directory.data.total)} you can reach` : undefined}
        actions={<input className="input search" type="search" aria-label="Search name, email, title" placeholder="Search name, email, title" value={searchText} onChange={(event) => setSearchText(event.target.value)} />}
      />
      <Loaded state={directory}>
        {({ people, total }) => (
          <section className="card">
            {people.length === 0 ? <p className="empty">Nobody matches this search.</p> : (
              <>
                <div className="table-box">
                  <table>
                    <thead>
                      <tr><th scope="col">Person</th><th scope="col">Job title</th><th scope="col">Department</th><th scope="col">Team</th><th scope="col">No.</th></tr>
                    </thead>
                    <tbody>
                      {people.map((person) => (
                        <tr key={person.id}>
                          <td>
                            <div className="person">
                              <PersonPhoto personId={person.id} name={person.name} photoUpdatedAt={person.photoUpdatedAt} online={person.online} />
                              <div><div className="strong">{person.name}</div><a className="meta" href={`mailto:${person.email}`}>{person.email}</a></div>
                            </div>
                          </td>
                          <td>{person.title ?? '·'}</td>
                          <td>{humanize(person.department)}</td>
                          <td>{humanize(person.team)}</td>
                          <td>{person.employeeNumber ?? '·'}</td>
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
    </>
  );
}
