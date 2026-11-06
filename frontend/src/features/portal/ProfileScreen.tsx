'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, DetailRow } from '@/components/ui/Card';
import { InputField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { useAuth, useSignedInAccount } from '@/features/auth/AuthProvider';
import { updateOwnName } from '@/features/auth/authApi';
import { ChangePasswordForm } from '@/features/auth/ChangePasswordForm';
import { errorMessage, fieldErrorMessage } from '@/lib/api/client';
import { humanizeKey } from '@/lib/format';
import styles from './portal.module.css';

function NameForm() {
  const { reloadAccount } = useAuth();
  const { profile } = useSignedInAccount();
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState<unknown>();
  const [isSaved, setIsSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(undefined);
    setIsSaved(false);
    try {
      await updateOwnName(name);
      await reloadAccount();
      setIsSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className={styles.nameForm}>
        <InputField
          label="Your name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldErrorMessage(error, 'name')}
        />
        <Button type="submit" disabled={isSaving || name.trim() === profile.name}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error !== undefined && <Notice tone="danger">{errorMessage(error)}</Notice>}
      {isSaved && <Notice tone="good">Your name has been saved.</Notice>}
    </form>
  );
}

export function ProfileScreen() {
  const { profile } = useSignedInAccount();
  const [isPasswordChanged, setIsPasswordChanged] = useState(false);

  return (
    <>
      <PageHeader title="Your profile" subtitle={profile.email} />
      <div className={styles.profileGrid}>
        <Card title="Your details">
          <NameForm />
          <DetailRow label="Email">{profile.email}</DetailRow>
          <DetailRow label="Job title">{profile.title ?? '·'}</DetailRow>
          <DetailRow label="Department">{humanizeKey(profile.department)}</DetailRow>
          <DetailRow label="Team">{humanizeKey(profile.team)}</DetailRow>
          <DetailRow label="Contract">{humanizeKey(profile.contract)}</DetailRow>
          <DetailRow label="Manager">{profile.manager?.name ?? '·'}</DetailRow>
          <p className={styles.note}>HR keeps your job details up to date. Ask them if something is wrong.</p>
        </Card>
        <Card title="Change password">
          {isPasswordChanged && <Notice tone="good">Your password has been changed, and your other sessions have ended.</Notice>}
          <ChangePasswordForm onChanged={() => setIsPasswordChanged(true)} />
        </Card>
      </div>
    </>
  );
}
