import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/api/client';
import { Button } from './Button';
import styles from './ui.module.css';

type NoticeTone = 'danger' | 'warning' | 'good';

const TONE_CLASS_NAMES: Record<NoticeTone, string | undefined> = {
  danger: styles.noticeDanger,
  warning: styles.noticeWarning,
  good: styles.noticeGood,
};

export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <p className={`${styles.notice} ${TONE_CLASS_NAMES[tone]}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

/** Text in place of content that's loading or empty. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <p className={styles.placeholder}>{children}</p>;
}

/** Shows why data couldn't load, with a way to try again. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className={styles.placeholder} role="alert">
      <p>{errorMessage(error)}</p>
      <Button variant="link" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
