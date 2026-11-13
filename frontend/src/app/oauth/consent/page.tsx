'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Notice } from '@/components/ui';
import { decideOAuthRequest, getOAuthRequest } from '@/lib/api/apiAccess';
import { describeError } from '@/lib/api/http';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

/** Where an app sends someone to approve connecting to TwinTrack. The app acts as them, with exactly their access. */
function ConsentForm() {
  const { status, profile } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const requestId = useSearchParams().get('request') ?? '';
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-out' || status === 'unavailable') {
      router.replace(`/sign-in?next=${encodeURIComponent(`${pathname}?request=${encodeURIComponent(requestId)}`)}`);
    }
  }, [status, pathname, requestId, router]);

  const request = useLoad(() => (status === 'signed-in' && requestId ? getOAuthRequest(requestId) : Promise.resolve(null)), [status, requestId]);

  const answer = async (approve: boolean) => {
    setIsBusy(true);
    setError('');
    try {
      const { redirectUrl } = await decideOAuthRequest(requestId, approve);
      window.location.assign(redirectUrl);
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  if (!requestId) return <Notice tone="warning">This page needs the link an app opened. Start connecting again from the app.</Notice>;
  if (status !== 'signed-in' || !profile || request.isLoading) return <p className="loading" role="status">Loading…</p>;
  if (request.error || !request.data) return <Notice tone="danger">{request.error ?? 'This request could not be found.'}</Notice>;

  const { clientName, redirectHost } = request.data;
  return (
    <>
      <div>
        <h1>Connect {clientName}?</h1>
        <p className="lede">It will be able to act as you, {profile.name}, with exactly your access in every module.</p>
      </div>
      <Notice tone="warning">
        Apps choose their own names. After you answer, your browser goes to <b>{redirectHost}</b>. Only continue if you started connecting
        there.
      </Notice>
      {profile.impersonatedBy ? <Notice tone="danger">You are signed in as someone else, so you can&apos;t connect an app for them.</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="dialog-actions">
        <button type="button" className="btn" disabled={isBusy} onClick={() => void answer(false)}>Decline</button>
        <button type="button" className="btn btn-primary" disabled={isBusy || Boolean(profile.impersonatedBy)} onClick={() => void answer(true)}>Allow</button>
      </div>
      <p className="note">You can disconnect it any time, under Apps and API tokens.</p>
    </>
  );
}

export default function OAuthConsentPage() {
  return (
    <div className="centered">
      <div className="auth">
        <span className="brand"><i aria-hidden="true" />TwinTrack</span>
        <section className="card">
          <Suspense fallback={<p className="loading" role="status">Loading…</p>}>
            <ConsentForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
