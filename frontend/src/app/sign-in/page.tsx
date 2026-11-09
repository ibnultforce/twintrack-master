'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Notice, TextField } from '@/components/ui';
import { describeConnectionProblem, describeError } from '@/lib/api/http';
import { useSession } from '@/session/SessionProvider';

export default function SignInPage() {
  const { status, profile, signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-in') router.replace(profile?.mustChangePassword ? '/change-password' : '/modules');
  }, [status, profile, router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    try {
      await signIn(email, password);
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
            <h1>Sign in</h1>
            <p className="lede">One account for all your TwinTrack modules.</p>
          </div>
          {status === 'unavailable' && !error ? <Notice tone="warning">{describeConnectionProblem()}</Notice> : null}
          <form className="form" onSubmit={(event) => void submit(event)}>
            <TextField id="email" label="Email" type="email" autoComplete="username" required value={email} onChange={setEmail} />
            <TextField id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={setPassword} />
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <button type="submit" className="btn btn-primary btn-full" disabled={isBusy}>{isBusy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        </section>
      </div>
    </div>
  );
}
