'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSignedInAccount } from '@/features/auth/AuthProvider';
import { initialsOf } from '@/lib/format';
import styles from './ui.module.css';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  const { profile } = useSignedInAccount();
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {subtitle && <p className={styles.pageSubtitle}>{subtitle}</p>}
      </div>
      <div className={styles.pageActions}>
        {actions}
        <Link href="/profile" className={styles.avatar} aria-label="Your profile">
          {initialsOf(profile.name)}
        </Link>
      </div>
    </header>
  );
}
