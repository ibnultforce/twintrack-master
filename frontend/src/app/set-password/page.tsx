'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Notice, TextField } from '@/components/ui';
import { setPasswordWithLink } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';

const MIN_PASSWORD_LENGTH = 8;

/** Opened from the emailed link, which carries a one-time token. Works without being signed in. */
function SetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const isReady = password.length >= MIN_PASSWORD_LENGTH && password === repeat;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    try {
      await setPasswordWithLink(token, password);
      setIsDone(true);
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  if (!token) {
    return (
      <section className="card">
        <h1>Set your password</h1>
        <Notice tone="warning">This page needs the link from your email. Open the link again, or ask an admin to send a new one.</Notice>
      </section>
    );
  }

  if (isDone) {
    return (
      <section className="card">
        <h1>Password set</h1>
        <Notice tone="good">You can now sign in with your new password. Any other sessions have been signed out.</Notice>
        <Link className="btn btn-primary btn-full" href="/sign-in">Sign in</Link>
      </section>
    );
  }

  return (
    <section className="card">
      <div>
        <h1>Set your password</h1>
        <p className="lede">Choose the password you&apos;ll use to sign in to TwinTrack. The link works once.</p>
      </div>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <TextField id="new-password" label="New password" type="password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} required value={password} onChange={setPassword} />
        <TextField
          id="repeat-password"
          label="Repeat new password"
          type="password"
          autoComplete="new-password"
          hint={repeat.length > 0 && repeat !== password ? "These two don't match yet." : undefined}
          required
          value={repeat}
          onChange={setRepeat}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" className="btn btn-primary btn-full" disabled={isBusy || !isReady}>{isBusy ? 'Saving…' : 'Set password'}</button>
      </form>
    </section>
  );
}

export default function SetPasswordPage() {
  return (
    <div className="centered">
      <div className="auth">
        <span className="brand"><i aria-hidden="true" />TwinTrack</span>
        <Suspense fallback={<section className="card"><p className="loading" role="status">Loading…</p></section>}>
          <SetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
