'use client';

import { useState, type FormEvent } from 'react';
import { Dialog } from '@/components/Dialog';
import { Chips, Loaded, Notice } from '@/components/ui';
import { listDirectory } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';
import { listOrgRoles } from '@/lib/api/modules';
import type { RecordShare, ShareGranteeType } from '@/lib/api/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

const GRANTEE_LABELS: Record<ShareGranteeType, string> = {
  user: 'A person',
  orgRole: 'An org role',
  orgRoleAndBelow: 'A role and everyone below it',
};

const ACCESS_LABELS: Record<RecordShare['access'], string> = { read: 'Can read', edit: 'Can read and edit' };

/** What the share list says about who it names, such as "Rumana Akter" or "Accounts team and below". */
function describeGrantee(share: RecordShare): string {
  const name = share.granteeName ?? 'Removed';
  if (share.granteeType === 'orgRole') return `${name} (org role)`;
  if (share.granteeType === 'orgRoleAndBelow') return `${name} and every role below it`;
  return name;
}

/** The people and org roles this person may pick from. Org roles need orgRole.read; without it, only people are offered. */
async function loadGranteeOptions(search: string) {
  const [people, roles] = await Promise.all([
    listDirectory({ page: 1, pageSize: 50, ...(search && { search }) }).then((answer) => answer.people),
    listOrgRoles().catch(() => null),
  ]);
  return { people, roles };
}

interface ShareDialogProps {
  /** Such as "Team lunch after release", for the title. */
  recordLabel: string;
  /** Such as "expense claims", to say what a share does not give. */
  objectLabel: string;
  canShare: boolean;
  loadShares: () => Promise<RecordShare[]>;
  addShare: (share: { granteeType: ShareGranteeType; granteeId: string; access: RecordShare['access']; expiresAt?: string }) => Promise<unknown>;
  removeShare: (shareId: string) => Promise<unknown>;
  onClose: () => void;
}

/**
 * Who a record is shared with, and, for someone who may share it, a form to share it further or take a share back.
 * A share opens this one record; it never gives a permission, so the person still needs read access to the object.
 */
export function ShareDialog({ recordLabel, objectLabel, canShare, loadShares, addShare, removeShare, onClose }: ShareDialogProps) {
  const shares = useLoad(loadShares, []);
  const [search, setSearch] = useState('');
  const options = useLoad(() => loadGranteeOptions(search), [search]);
  const [granteeType, setGranteeType] = useState<ShareGranteeType>('user');
  const [granteeId, setGranteeId] = useState('');
  const [access, setAccess] = useState<RecordShare['access']>('read');
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const mayPickRoles = Boolean(options.data?.roles);
  const granteeTypes = (Object.keys(GRANTEE_LABELS) as ShareGranteeType[])
    .filter((type) => type === 'user' || mayPickRoles)
    .map((type) => ({ value: type, label: GRANTEE_LABELS[type] }));

  const run = async (work: () => Promise<unknown>, done: string) => {
    setError('');
    setOutcome('');
    setIsSaving(true);
    try {
      await work();
      setOutcome(done);
      shares.reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!granteeId) {
      setError(granteeType === 'user' ? 'Pick a person.' : 'Pick an org role.');
      return;
    }
    // The end of the chosen day, in the browser's time zone, so "until 31 December" includes that day.
    const expiresAt = until ? new Date(`${until}T23:59:59`).toISOString() : undefined;
    void run(async () => {
      await addShare({ granteeType, granteeId, access, ...(expiresAt && { expiresAt }) });
      setGranteeId('');
      setUntil('');
    }, 'Shared.');
  };

  return (
    <Dialog title={`Sharing: ${recordLabel}`} onClose={onClose}>
      <div className="stack">
        <section className="card">
          <h3 className="m-0 mb-2 text-base">Shared with</h3>
          <Loaded state={shares}>
            {(list) => list.length === 0 ? <p className="empty">Not shared with anyone. People whose own access reaches it can still see it.</p> : (
              <div className="table-box">
                <table>
                  <thead><tr><th scope="col">Who</th><th scope="col">Access</th><th scope="col">Shared by</th>{canShare ? <th scope="col"><span className="visually-hidden">Remove</span></th> : null}</tr></thead>
                  <tbody>
                    {list.map((share) => (
                      <tr key={share.id}>
                        <td>
                          <div className="strong">{describeGrantee(share)}</div>
                          {share.expiresAt ? <div className="meta">Until {formatTime(share.expiresAt)}</div> : null}
                        </td>
                        <td><span className={`pill ${share.access === 'edit' ? 'pill-warning' : 'pill-neutral'}`}>{ACCESS_LABELS[share.access]}</span></td>
                        <td className="meta">{share.sharedByName ?? 'Someone removed'}, {formatTime(share.createdAt)}</td>
                        {canShare ? (
                          <td><button type="button" className="link" disabled={isSaving} onClick={() => void run(() => removeShare(share.id), 'Share removed.')}>Remove</button></td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loaded>
        </section>

        {canShare ? (
          <form className="card form" onSubmit={submit}>
            <h3 className="m-0 text-base">Share it with</h3>
            <Chips label="Share with" options={granteeTypes} value={granteeType} onChange={(next) => { setGranteeType(next); setGranteeId(''); }} />
            <Loaded state={options}>
              {({ people, roles }) => granteeType === 'user' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="field">
                    <label htmlFor="share-search">Find a person</label>
                    <input className="input" id="share-search" type="search" placeholder="Name or email" value={search} onChange={(event) => setSearch(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="share-person">Person</label>
                    <select className="input" id="share-person" value={granteeId} onChange={(event) => setGranteeId(event.target.value)}>
                      <option value="">Choose…</option>
                      {people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.title ? `, ${person.title}` : ''}</option>)}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="share-role">Org role</label>
                  <select className="input" id="share-role" value={granteeId} onChange={(event) => setGranteeId(event.target.value)}>
                    <option value="">Choose…</option>
                    {(roles ?? []).map((role) => <option key={role.id} value={role.id}>{'  '.repeat(role.depth)}{role.name}</option>)}
                  </select>
                </div>
              )}
            </Loaded>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="field">
                <label htmlFor="share-access">Access</label>
                <select className="input" id="share-access" value={access} onChange={(event) => setAccess(event.target.value as RecordShare['access'])}>
                  <option value="read">{ACCESS_LABELS.read}</option>
                  <option value="edit">{ACCESS_LABELS.edit}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="share-until">Until (optional)</label>
                <input className="input" id="share-until" type="date" value={until} min={new Date().toLocaleDateString('en-CA')} onChange={(event) => setUntil(event.target.value)} />
              </div>
            </div>
            <p className="note">
              Sharing opens this one record. It never gives a permission: they still need read access to {objectLabel}, and edit access to change it. Sharing again with the same person or role changes their access.
            </p>
            <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={isSaving}>{isSaving ? 'Sharing…' : 'Share'}</button></div>
          </form>
        ) : (
          <p className="note">Only the record&apos;s owner, someone above them, or someone allowed to share {objectLabel} can change who it is shared with.</p>
        )}
        {outcome ? <Notice tone="good">{outcome}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}
