'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { arePasswordsReady, EMPTY_PASSWORDS, PasswordFields } from '@/components/PasswordFields';
import { Notice } from '@/components/ui';
import { changeMyPassword } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';
import { useSession } from '@/session/SessionProvider';

export default function ChangePasswordPage() {
  const { status, profile, refreshSession, signOut } = useSession();
  const router = useRouter();
  const [passwords, setPasswords] = useState(EMPTY_PASSWORDS);
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-out' || status === 'unavailable') router.replace('/sign-in');
    else if (status === 'signed-in' && !profile?.mustChangePassword) router.replace('/modules');
  }, [status, profile, router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    try {
      await changeMyPassword(passwords.current, passwords.next);
      await refreshSession();
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="auth">
        <span className="brand"><i aria-hidden="true" />TwinTrack</span>
        <section className="card">
          <div>
            <h1>Choose a new password</h1>
            <p className="lede">Your password is temporary. Replace it to continue.</p>
          </div>
          <form className="form" onSubmit={(event) => void submit(event)}>
            <PasswordFields idPrefix="temporary" currentLabel="Temporary password" values={passwords} onChange={setPasswords} />
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <button type="submit" className="btn btn-primary btn-full" disabled={isBusy || !arePasswordsReady(passwords)}>Set password</button>
          </form>
          <button type="button" className="link" onClick={() => void signOut()}>Sign out</button>
        </section>
      </div>
    </div>
  );
}
