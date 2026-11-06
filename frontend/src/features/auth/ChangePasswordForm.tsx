'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { InputField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { errorMessage, fieldErrorMessage } from '@/lib/api/client';
import { MIN_PASSWORD_LENGTH } from '@/lib/config';
import { changeOwnPassword } from './authApi';

interface ChangePasswordFormProps {
  onChanged: () => Promise<void> | void;
  currentPasswordLabel?: string;
}

const EMPTY_PASSWORDS = { currentPassword: '', newPassword: '', repeatedPassword: '' };

function findMismatchMessage(newPassword: string, repeatedPassword: string): string | undefined {
  if (repeatedPassword && newPassword !== repeatedPassword) return 'The two new passwords do not match.';
  return undefined;
}

export function ChangePasswordForm({ onChanged, currentPasswordLabel = 'Current password' }: ChangePasswordFormProps) {
  const [passwords, setPasswords] = useState(EMPTY_PASSWORDS);
  const [error, setError] = useState<unknown>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const mismatchMessage = findMismatchMessage(passwords.newPassword, passwords.repeatedPassword);
  const canSubmit = Boolean(passwords.currentPassword && passwords.newPassword && passwords.repeatedPassword && !mismatchMessage);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      await changeOwnPassword({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword });
      setPasswords(EMPTY_PASSWORDS);
      await onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <InputField
        label={currentPasswordLabel}
        type="password"
        autoComplete="current-password"
        value={passwords.currentPassword}
        onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })}
        error={fieldErrorMessage(error, 'currentPassword')}
      />
      <InputField
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={passwords.newPassword}
        onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })}
        error={fieldErrorMessage(error, 'newPassword')}
      />
      <InputField
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        value={passwords.repeatedPassword}
        onChange={(event) => setPasswords({ ...passwords, repeatedPassword: event.target.value })}
        error={mismatchMessage}
      />
      {error !== undefined && <Notice tone="danger">{errorMessage(error)}</Notice>}
      <Button type="submit" variant="primary" disabled={!canSubmit || isSubmitting}>
        {isSubmitting ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  );
}
