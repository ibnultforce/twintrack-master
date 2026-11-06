'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './ui.module.css';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** A modal using the browser's dialog element, which handles focus and the Escape key. Render it only while open. */
export function Dialog({ title, onClose, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-label={title} onClose={onClose}>
      <h2 className={styles.dialogTitle}>{title}</h2>
      {children}
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.dialogActions}>{children}</div>;
}
