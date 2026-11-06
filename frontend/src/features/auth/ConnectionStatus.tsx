'use client';

import { Badge } from '@/components/ui/Badge';
import { useAsyncData } from '@/lib/useAsyncData';
import { checkApiHealth } from './authApi';

/** Shown on the sign-in page, so a failed sign-in caused by an outage is easy to tell apart. */
export function ConnectionStatus() {
  const { error, isLoading } = useAsyncData(checkApiHealth);

  if (isLoading) return <Badge tone="neutral">Checking the API…</Badge>;
  if (error) return <Badge tone="danger">API or database unavailable</Badge>;
  return <Badge tone="good">API and database connected</Badge>;
}
