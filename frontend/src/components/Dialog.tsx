'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError } from '@/lib/api/http';
import { Notice } from './ui';

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

/** Temporary passwords are returned only once, so this stays open until the admin closes it. */
export function TemporaryPasswordDialog({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  const [copyState, setCopyState] = useState('Copy');

  const copy = () => {
    navigator.clipboard.writeText(password).then(
      () => setCopyState('Copied'),
      () => setCopyState('Copy it by hand'),
    );
  };

  return (
    <Dialog title="Temporary password" onClose={onClose}>
      <p>Give this to {name}. It won&apos;t be shown again, and they&apos;ll replace it when they first sign in.</p>
      <code className="temporary">{password}</code>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={copy}>{copyState}</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
