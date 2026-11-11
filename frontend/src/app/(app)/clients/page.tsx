'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClientFormDialog } from '@/components/ClientFormDialog';
import { Chips, ClientStatusPill, Loaded, PageHead, Pagination } from '@/components/ui';
import { createClient, listClients } from '@/lib/api/clients';
import type { ClientStatus } from '@/lib/api/types';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 250;

type StatusFilter = 'all' | ClientStatus;

const clientCount = (count: number) => (count === 1 ? '1 client' : `${count} clients`);

/** Companies TwinTrack works for, shared by every module: projects, invoices and receipts all name them. */
export default function ClientsPage() {
  const { can } = useSession();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [page, setPage] = useState(1);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const clients = useLoad(() => listClients({ page, pageSize: PAGE_SIZE, search, status: status === 'all' ? undefined : status }), [page, search, status]);

  return (
    <>
      <PageHead
        title="Clients"
        subtitle={clients.data ? clientCount(clients.data.total) : undefined}
        actions={(
          <>
            <input className="input search" type="search" aria-label="Search name, initials, email" placeholder="Search name, initials, email" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
            {can('client.create') ? <button type="button" className="btn btn-primary" onClick={() => setIsAdding(true)}>+ Add client</button> : null}
          </>
        )}
      />
      <div className="toolbar">
        <Chips
          label="Filter by status"
          value={status}
          onChange={(next) => {
            setStatus(next);
            setPage(1);
          }}
          options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]}
        />
      </div>
      <Loaded state={clients}>
        {({ clients: rows, total }) => (
          <section className="card">
            {rows.length === 0 ? <p className="empty">No clients match.</p> : (
              <>
                <div className="table-box">
                  <table>
                    <thead>
                      <tr><th scope="col">Client</th><th scope="col">Initials</th><th scope="col">Billing email</th><th scope="col">Phone</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Details</span></th></tr>
                    </thead>
                    <tbody>
                      {rows.map((client) => (
                        <tr key={client.id}>
                          <td className="strong">{client.name}</td>
                          <td>{client.initials ?? '·'}</td>
                          <td>{client.contactEmail ?? '·'}</td>
                          <td>{client.contactPhone ?? '·'}</td>
                          <td><ClientStatusPill status={client.status} /></td>
                          <td><Link className="link" href={`/clients/${encodeURIComponent(client.id)}`} aria-label={`Details for ${client.name}`}>Details</Link></td>
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
        <ClientFormDialog
          title="Add a client"
          submitLabel="Add client"
          onClose={() => setIsAdding(false)}
          onSubmit={async (details) => {
            // A new client has nothing to clear, and the API accepts only values for the optional fields here.
            await createClient(Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null)));
            clients.reload();
          }}
        />
      ) : null}
    </>
  );
}
