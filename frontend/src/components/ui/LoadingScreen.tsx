import styles from './ui.module.css';

export function LoadingScreen() {
  return (
    <div className={styles.loadingScreen} role="status">
      Loading…
    </div>
  );
}
