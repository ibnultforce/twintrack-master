'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError } from '@/lib/api/http';
import type { PasswordLinkError, PasswordLinkResult } from '@/lib/api/types';
import { Notice, Pill } from './ui';

/** A modal built on the native dialog element, which handles focus and the Escape key. */
export function Dialog({ title, onClose, children, isWide = false }: { title: string; onClose: () => void; children: ReactNode; isWide?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={dialogRef} className={isWide ? 'dialog-wide' : undefined} aria-labelledby="dialog-title" onCancel={onClose}>
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, isDanger, onConfirm, onClose }: {
  title: string;
  text: string;
  confirmLabel: string;
  isDanger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const confirm = async () => {
    setIsBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <p>{text}</p>
      {error ? <div className="spaced"><Notice tone="danger">{error}</Notice></div> : null}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${isDanger ? 'btn-danger' : 'btn-primary'}`} disabled={isBusy} onClick={() => void confirm()}>{confirmLabel}</button>
      </div>
    </Dialog>
  );
}

/** For a secret the API returns only once, such as a new API token, so this stays open until it's closed. */
export function OneTimeSecretDialog({ title, text, secret, onClose }: { title: string; text: string; secret: string; onClose: () => void }) {
  const [copyState, setCopyState] = useState('Copy');

  const copy = () => {
    navigator.clipboard.writeText(secret).then(
      () => setCopyState('Copied'),
      () => setCopyState('Copy it by hand'),
    );
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <p>{text}</p>
      <code className="temporary">{secret}</code>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={copy}>{copyState}</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

const LINK_ERRORS: Record<PasswordLinkError, string> = {
  unknown_user: 'No longer exists',
  account_inactive: 'Deactivated, so not sent',
  super_admin_protected: 'Only a super admin can send this',
  own_account: 'Your own account: change your password on Your profile',
  email_failed: "The email couldn't be sent. Try again later",
};

/** What happened for each person after sending password links. */
export function PasswordLinkResultsDialog({ results, names, onClose }: { results: PasswordLinkResult[]; names: Map<string, string>; onClose: () => void }) {
  const sentCount = results.filter((result) => result.sent).length;
  return (
    <Dialog title="Password links" onClose={onClose}>
      <p>{sentCount === results.length ? 'Every link was sent.' : `${sentCount} of ${results.length} sent.`} Each link works once, and only for a limited time.</p>
      <ul className="result-list spaced">
        {results.map((result) => (
          <li key={result.userId}>
            <span>{names.get(result.userId) ?? result.email ?? result.userId}</span>
            {result.sent ? <Pill tone="good">Sent</Pill> : <Pill tone="danger">{LINK_ERRORS[result.error ?? 'email_failed']}</Pill>}
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
