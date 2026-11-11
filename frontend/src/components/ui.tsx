'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import type { ClientStatus, Contract, UserStatus } from '@/lib/api/types';
import { humanize, initials } from '@/lib/format';
import type { LoadState } from '@/lib/useLoad';

export type PillTone = 'accent' | 'good' | 'warning' | 'danger' | 'neutral';

export const Pill = ({ tone, children }: { tone: PillTone; children: ReactNode }) => <span className={`pill pill-${tone}`}>{children}</span>;

export const Avatar = ({ name }: { name: string }) => <span className="avatar" aria-hidden="true">{initials(name)}</span>;

const CONTRACT_TONES: Record<Contract, PillTone> = { permanent: 'accent', intern: 'neutral', contractor: 'warning' };

export const ContractPill = ({ contract }: { contract: Contract }) => <Pill tone={CONTRACT_TONES[contract]}>{humanize(contract)}</Pill>;

export const StatusPill = ({ status }: { status: UserStatus }) => (status === 'active' ? <Pill tone="good">Active</Pill> : <Pill tone="danger">Deactivated</Pill>);

export const ClientStatusPill = ({ status }: { status: ClientStatus }) => (status === 'active' ? <Pill tone="good">Active</Pill> : <Pill tone="neutral">Inactive</Pill>);

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title || aside ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'good' | 'danger' | 'warning'; children: ReactNode }) {
  return <p className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</p>;
}

/**
 * A row of tabs that switches what's shown below it. Arrow keys move between tabs, as screen readers expect.
 * The panel it controls should have id `${id}-panel` and role="tabpanel".
 */
export function Tabs<Value extends string>({ id, label, options, value, onChange }: {
  id: string;
  label: string;
  options: { value: Value; label: string; count?: number }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    document.getElementById(`${id}-tab-${next.value}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((option, index) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${id}-tab-${option.value}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={isSelected}
            aria-controls={`${id}-panel`}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {option.label}
            {option.count !== undefined ? <span className="tab-count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Chips<Value extends string>({ label, options, value, onChange }: {
  label: string;
  options: { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="chip" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <nav className="pagination" aria-label="Pages">
      <span>{firstShown} to {Math.min(page * pageSize, total)} of {total}</span>
      <div>
        <button type="button" className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
        <button type="button" className="btn" disabled={page >= lastPage} onClick={() => onChange(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

/** Shows loading and failure states, and the content once there's data. */
export function Loaded<Data>({ state, children }: { state: LoadState<Data>; children: (data: Data) => ReactNode }) {
  if (state.data !== undefined) {
    return (
      <>
        {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
        {children(state.data)}
      </>
    );
  }
  if (state.error) {
    return (
      <section className="card">
        <Notice tone="danger">{state.error}</Notice>
        <div className="actions"><button type="button" className="btn" onClick={state.reload}>Try again</button></div>
      </section>
    );
  }
  return <section className="card"><p className="loading" role="status">Loading…</p></section>;
}

export function TextField({ id, label, value, onChange, type = 'text', autoComplete = 'off', hint, required }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input className="input" id={id} type={type} value={value} autoComplete={autoComplete} required={required} onChange={(event) => onChange(event.target.value)} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
