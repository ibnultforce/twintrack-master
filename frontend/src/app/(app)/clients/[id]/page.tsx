'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ClientFormDialog } from '@/components/ClientFormDialog';
import { ConfirmDialog } from '@/components/Dialog';
import { Card, ClientStatusPill, Loaded, PageHead, Row } from '@/components/ui';
import { getClient, getClientHistory, setClientStatus, updateClient } from '@/lib/api/clients';
import { formatTime, humanize } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  initials: 'Initials',
  contactEmail: 'Billing email',
  contactPhone: 'Phone',
  address: 'Address',
  notes: 'Notes',
  status: 'Status',
};

const showValue = (value: unknown) => (value === undefined || value === null || value === '' ? 'nothing' : String(value));

export default function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [dialog, setDialog] = useState<'edit' | 'status' | null>(null);

  const details = useLoad(async () => {
    const [client, history] = await Promise.all([getClient(id), getClientHistory(id)]);
    return { client, history };
  }, [id]);

  return (
    <>
      <Link className="back" href="/clients">← Clients</Link>
      <Loaded state={details}>
        {({ client, history }) => {
          const isActive = client.status === 'active';
          return (
            <>
              <PageHead title={client.name} subtitle={client.initials ? `Initials ${client.initials}` : undefined} />
              <div className="pair">
                <Card title="Details" aside={can('client.update') ? <button type="button" className="link" onClick={() => setDialog('edit')}>Edit</button> : undefined}>
                  <Row label="Status"><ClientStatusPill status={client.status} /></Row>
                  <Row label="Billing email">{client.contactEmail ?? '·'}</Row>
                  <Row label="Phone">{client.contactPhone ?? '·'}</Row>
                  <Row label="Address">{client.address ?? '·'}</Row>
                  {client.notes !== undefined ? <Row label="Notes">{client.notes}</Row> : null}
                  <Row label="Added">{formatTime(client.createdAt)}</Row>
                  {can('client.update') ? (
                    <div className="actions">
                      <button type="button" className={`btn ${isActive ? 'btn-danger' : ''}`} onClick={() => setDialog('status')}>{isActive ? 'Make inactive' : 'Make active'}</button>
                    </div>
                  ) : null}
                </Card>
                <Card title="History">
                  {history.length === 0 ? <p className="empty">No changes yet.</p> : (
                    <ul className="history-list">
                      {history.map((entry) => (
                        <li key={entry.id}>
                          <div className="strong">{humanize(entry.action)} by {entry.actorName}</div>
                          <div className="meta">{formatTime(entry.at)}</div>
                          {entry.action === 'updated'
                            ? entry.changes.map((change) => <div key={change.field} className="meta">{FIELD_LABELS[change.field] ?? humanize(change.field)}: {showValue(change.from)} → {showValue(change.to)}</div>)
                            : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              {dialog === 'edit' ? (
                <ClientFormDialog
                  title={`Edit ${client.name}`}
                  submitLabel="Save"
                  client={client}
                  onClose={() => setDialog(null)}
                  onSubmit={async (changes) => {
                    await updateClient(client.id, changes, client.version);
                    details.reload();
                  }}
                />
              ) : null}
              {dialog === 'status' ? (
                <ConfirmDialog
                  title={isActive ? `Make ${client.name} inactive?` : `Make ${client.name} active?`}
                  text={isActive ? 'It stays on every record that names it, but new work can no longer be added for it.' : 'New work can be added for it again.'}
                  confirmLabel={isActive ? 'Make inactive' : 'Make active'}
                  isDanger={isActive}
                  onClose={() => setDialog(null)}
                  onConfirm={async () => {
                    await setClientStatus(client.id, isActive ? 'inactive' : 'active', client.version);
                    details.reload();
                  }}
                />
              ) : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
