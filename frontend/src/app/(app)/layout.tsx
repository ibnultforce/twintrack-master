'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useAuth } from '@/features/auth/AuthProvider';

/** Every signed-in page. Sends everyone else to sign in, and temporary passwords to be changed first. */
export default function SignedInLayout({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const router = useRouter();
  const isPasswordChangeNeeded = state.status === 'signedIn' && state.profile.mustChangePassword;

  useEffect(() => {
    if (state.status === 'signedOut') router.replace('/login');
    if (isPasswordChangeNeeded) router.replace('/change-password');
  }, [state.status, isPasswordChangeNeeded, router]);

  if (state.status !== 'signedIn' || isPasswordChangeNeeded) return <LoadingScreen />;
  return <AppShell>{children}</AppShell>;
}
