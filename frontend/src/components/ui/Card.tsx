import type { ReactNode } from 'react';
import styles from './ui.module.css';

interface CardProps {
  title?: string;
  /** Sits beside the title, such as a badge or a button. */
  titleAside?: ReactNode;
  children: ReactNode;
}

export function Card({ title, titleAside, children }: CardProps) {
  return (
    <section className={styles.card}>
      {title && (
        <div className={styles.cardTitle}>
          <h2>{title}</h2>
          {titleAside}
        </div>
      )}
      {children}
    </section>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{children}</span>
    </div>
  );
}

/** A table that scrolls sideways by itself on narrow screens. Give it thead and tbody as children. */
export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}
