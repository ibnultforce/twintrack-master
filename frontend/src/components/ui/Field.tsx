import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import styles from './ui.module.css';

interface FieldText {
  label: string;
  hint?: string;
  error?: string;
}

interface FieldFrameProps extends FieldText {
  inputId: string;
  messageId: string;
  children: ReactNode;
}

function FieldFrame({ label, hint, error, inputId, messageId, children }: FieldFrameProps) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      {children}
      {error && (
        <span id={messageId} className={styles.fieldError}>
          {error}
        </span>
      )}
      {!error && hint && (
        <span id={messageId} className={styles.fieldHint}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function InputField({ label, hint, error, ...inputProps }: FieldText & InputHTMLAttributes<HTMLInputElement>) {
  const inputId = useId();
  const messageId = useId();
  return (
    <FieldFrame label={label} hint={hint} error={error} inputId={inputId} messageId={messageId}>
      <input
        id={inputId}
        className={styles.input}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? messageId : undefined}
        {...inputProps}
      />
    </FieldFrame>
  );
}

export function SelectField({ label, hint, error, children, ...selectProps }: FieldText & SelectHTMLAttributes<HTMLSelectElement>) {
  const inputId = useId();
  const messageId = useId();
  return (
    <FieldFrame label={label} hint={hint} error={error} inputId={inputId} messageId={messageId}>
      <select
        id={inputId}
        className={styles.input}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? messageId : undefined}
        {...selectProps}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

export function SearchInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      className={`${styles.input} ${styles.search}`}
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
