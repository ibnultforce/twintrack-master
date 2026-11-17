'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, Notice, PageHead } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { createHandoff } from '@/lib/api/modules';

/**
 * Signs the person in to a module's frontend: gets a one-time code and sends the browser to the module with it. A
 * module also sends people here when its access token runs out, which brings them straight back while their portal
 * session lasts. The app layout sends anyone signed out to sign in first.
 */
export default function OpenModulePage() {
  const { key } = useParams<{ key: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    createHandoff(key)
      .then(({ redirectTo }) => {
        if (isCurrent) window.location.replace(redirectTo);
      })
      .catch((failure: unknown) => {
        if (isCurrent) setError(describeError(failure));
      });
    return () => {
      isCurrent = false;
    };
  }, [key]);

  return (
    <>
      <PageHead title="Opening the app" />
      <Card>
        {error ? (
          <>
            <Notice tone="danger">{error}</Notice>
            <p><Link className="link" href="/modules">Back to your modules</Link></p>
          </>
        ) : <p className="muted">Signing you in…</p>}
      </Card>
    </>
  );
}
