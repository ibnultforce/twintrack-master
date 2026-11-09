'use client';

import { TextField } from './ui';

const MIN_PASSWORD_LENGTH = 8;

export interface PasswordValues {
  current: string;
  next: string;
  repeat: string;
}

export const EMPTY_PASSWORDS: PasswordValues = { current: '', next: '', repeat: '' };

export const arePasswordsReady = ({ current, next, repeat }: PasswordValues) =>
  current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === repeat && next !== current;

export function PasswordFields({ idPrefix, currentLabel, values, onChange }: {
  idPrefix: string;
  currentLabel: string;
  values: PasswordValues;
  onChange: (values: PasswordValues) => void;
}) {
  const hasMismatch = values.repeat.length > 0 && values.next !== values.repeat;
  return (
    <>
      <TextField id={`${idPrefix}-current`} label={currentLabel} type="password" autoComplete="current-password" value={values.current} onChange={(current) => onChange({ ...values, current })} />
      <TextField id={`${idPrefix}-new`} label="New password" type="password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} value={values.next} onChange={(next) => onChange({ ...values, next })} />
      <TextField id={`${idPrefix}-repeat`} label="Repeat new password" type="password" autoComplete="new-password" hint={hasMismatch ? 'These two don\'t match yet.' : undefined} value={values.repeat} onChange={(repeat) => onChange({ ...values, repeat })} />
    </>
  );
}
