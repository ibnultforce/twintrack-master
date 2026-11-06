import styles from './ui.module.css';

export function BrandMark() {
  return (
    <span className={styles.brand}>
      <span className={styles.brandDot} aria-hidden="true" />
      TwinTrack
    </span>
  );
}
