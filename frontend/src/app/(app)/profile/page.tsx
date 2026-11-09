'use client';

import { useState, type FormEvent } from 'react';
import { arePasswordsReady, EMPTY_PASSWORDS, PasswordFields } from '@/components/PasswordFields';
import { Card, Notice, PageHead, Row, TextField } from '@/components/ui';
import { changeMyPassword, updateMyName } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';
import { humanize } from '@/lib/format';
import { useProfile, useSession } from '@/session/SessionProvider';

type Outcome = { tone: 'good' | 'danger'; text: string } | null;

export default function YourProfilePage() {
  const profile = useProfile();
  const { refreshSession } = useSession();
  const [name, setName] = useState(profile.name);
  const [nameOutcome, setNameOutcome] = useState<Outcome>(null);
  const [passwords, setPasswords] = useState(EMPTY_PASSWORDS);
  const [passwordOutcome, setPasswordOutcome] = useState<Outcome>(null);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await updateMyName(name);
      await refreshSession();
      setNameOutcome({ tone: 'good', text: 'Your name has been saved.' });
    } catch (failure) {
      setNameOutcome({ tone: 'danger', text: describeError(failure) });
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await changeMyPassword(passwords.current, passwords.next);
      setPasswords(EMPTY_PASSWORDS);
      setPasswordOutcome({ tone: 'good', text: 'Password changed. Your other sessions have been signed out.' });
    } catch (failure) {
      setPasswordOutcome({ tone: 'danger', text: describeError(failure) });
    }
  };

  return (
    <>
      <PageHead title="Your profile" subtitle={profile.email} />
      <div className="pair">
        <Card title="Your details">
          <form className="form" onSubmit={(event) => void saveName(event)}>
            <TextField id="own-name" label="Your name" required value={name} onChange={setName} />
            {nameOutcome ? <Notice tone={nameOutcome.tone}>{nameOutcome.text}</Notice> : null}
            <div><button type="submit" className="btn" disabled={name.trim() === profile.name}>Save name</button></div>
          </form>
          <div className="spaced">
            <Row label="Email">{profile.email}</Row>
            <Row label="Job title">{profile.title ?? '·'}</Row>
            <Row label="Department">{humanize(profile.department)}</Row>
            <Row label="Team">{humanize(profile.team)}</Row>
            <Row label="Contract">{humanize(profile.contract)}</Row>
            <Row label="Manager">{profile.manager?.name ?? '·'}</Row>
          </div>
          <p className="note spaced">HR keeps your job details up to date. Ask them if something is wrong.</p>
        </Card>
        <Card title="Change password">
          <form className="form" onSubmit={(event) => void savePassword(event)}>
            <PasswordFields idPrefix="own" currentLabel="Current password" values={passwords} onChange={setPasswords} />
            {passwordOutcome ? <Notice tone={passwordOutcome.tone}>{passwordOutcome.text}</Notice> : null}
            <div><button type="submit" className="btn btn-primary" disabled={!arePasswordsReady(passwords)}>Change password</button></div>
          </form>
        </Card>
      </div>
    </>
  );
}
