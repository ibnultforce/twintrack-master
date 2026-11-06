import type { ReactNode } from 'react';
import styles from './ui.module.css';

export function StatTiles({ children }: { children: ReactNode }) {
  return <div className={styles.tiles}>{children}</div>;
}

export function StatTile({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note && <span className={styles.tileNote}>{note}</span>}
    </div>
  );
}
