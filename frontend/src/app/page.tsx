'use client';

import { useEffect, useState } from 'react';

type ApiState = 'checking' | 'ok' | 'unavailable';

const LABELS: Record<ApiState, string> = {
  checking: 'Checking the API…',
  ok: 'API and database connected',
  unavailable: 'API or database unavailable',
};

export default function HomePage() {
  const [state, setState] = useState<ApiState>('checking');

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/health`)
      .then((res) => setState(res.ok ? 'ok' : 'unavailable'))
      .catch(() => setState('unavailable'));
  }, []);

  return (
    <main className="placeholder">
      <h1>TwinTrack</h1>
      <p>Sign-in comes in a later phase.</p>
      <p className="status" data-state={state} role="status">
        {LABELS[state]}
      </p>
    </main>
  );
}
