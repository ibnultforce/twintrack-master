'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { BrandMark } from '@/components/ui/BrandMark';
import { useAuth } from '@/features/auth/AuthProvider';
import { ConnectionStatus } from '@/features/auth/ConnectionStatus';
import { LoginForm } from '@/features/auth/LoginForm';
import styles from '@/features/auth/auth.module.css';

export default function LoginPage() {
  const { state } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'signedIn') router.replace('/');
  }, [state.status, router]);

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <section className={styles.card}>
          <BrandMark />
          <div className={styles.heading}>
            <h1>Sign in</h1>
            <p>One account for all your TwinTrack modules.</p>
          </div>
          <LoginForm />
        </section>
        <div className={styles.footer}>
          <ConnectionStatus />
        </div>
      </div>
    </main>
  );
}
