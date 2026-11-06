'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/ui/BrandMark';
import { Button } from '@/components/ui/Button';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { Notice } from '@/components/ui/Notice';
import { useAuth } from '@/features/auth/AuthProvider';
import { ChangePasswordForm } from '@/features/auth/ChangePasswordForm';
import styles from '@/features/auth/auth.module.css';
import { errorMessage } from '@/lib/api/client';

/** The one screen someone with a temporary password can use, apart from signing out. */
export default function ChangePasswordPage() {
  const { state, reloadAccount, signOut } = useAuth();
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<unknown>();

  const isPasswordChangeNeeded = state.status === 'signedIn' && state.profile.mustChangePassword;

  useEffect(() => {
    if (state.status === 'signedOut') router.replace('/login');
    if (state.status === 'signedIn' && !isPasswordChangeNeeded) router.replace('/');
  }, [state.status, isPasswordChangeNeeded, router]);

  if (!isPasswordChangeNeeded) return <LoadingScreen />;

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <section className={styles.card}>
          <BrandMark />
          <div className={styles.heading}>
            <h1>Choose a new password</h1>
            <p>Your password is temporary. Replace it to continue.</p>
          </div>
          <ChangePasswordForm currentPasswordLabel="Temporary password" onChanged={reloadAccount} />
        </section>
        {signOutError !== undefined && <Notice tone="danger">{errorMessage(signOutError)}</Notice>}
        <div className={styles.footer}>
          <Button variant="link" onClick={() => signOut().catch(setSignOutError)}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
