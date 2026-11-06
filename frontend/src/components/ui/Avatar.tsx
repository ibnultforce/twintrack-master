import { initialsOf } from '@/lib/format';
import styles from './ui.module.css';

export function Avatar({ name }: { name: string }) {
  return (
    <span className={styles.avatar} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
