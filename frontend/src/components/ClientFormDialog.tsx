'use client';

import { useState, type FormEvent } from 'react';
import { describeError } from '@/lib/api/http';
import type { Client, ClientDetails } from '@/lib/api/types';
import { Dialog } from './Dialog';
import { Notice, TextField } from './ui';

/** Adding and editing a client. Submits every field, with blank optional ones as null. */
export function ClientFormDialog({ title, submitLabel, client, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  client?: Client;
  onSubmit: (details: ClientDetails) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(client?.name ?? '');
  const [initials, setInitials] = useState(client?.initials ?? '');
  const [contactEmail, setContactEmail] = useState(client?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(client?.contactPhone ?? '');
  const [address, setAddress] = useState(client?.address ?? '');
  const [notes, setNotes] = useState(client?.notes ?? '');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const orNull = (value: string) => value.trim() || null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    try {
      await onSubmit({
        name,
        initials: orNull(initials),
        contactEmail: orNull(contactEmail),
        contactPhone: orNull(contactPhone),
        address: orNull(address),
        notes: orNull(notes),
      });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <p className="required-legend">Fields marked <span aria-hidden="true">*</span> are required.</p>
        <TextField id="client-name" label="Name" required value={name} onChange={setName} />
        <TextField id="client-initials" label="Initials" hint="1 to 8 letters or digits, used in invoice numbers. Unique." value={initials} onChange={setInitials} />
        <TextField id="client-email" label="Billing email" type="email" value={contactEmail} onChange={setContactEmail} />
        <TextField id="client-phone" label="Phone" value={contactPhone} onChange={setContactPhone} />
        <TextField id="client-address" label="Address" value={address} onChange={setAddress} />
        <div className="field">
          <label htmlFor="client-notes">Notes</label>
          <textarea className="input" id="client-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isBusy || !name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}
