import type { ReactNode } from 'react';
import styles from './ui.module.css';

export type BadgeTone = 'accent' | 'good' | 'warning' | 'danger' | 'neutral';

const TONE_CLASS_NAMES: Record<BadgeTone, string | undefined> = {
  accent: styles.badgeAccent,
  good: styles.badgeGood,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
  neutral: styles.badgeNeutral,
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${TONE_CLASS_NAMES[tone]}`}>{children}</span>;
}
