'use client';

import { useState } from 'react';
import type { GrantablePermission } from '@/lib/api/types';
import { SCOPE_LABELS } from '@/lib/format';
import { SearchCombobox } from './SearchCombobox';

/** Picks several permissions. Each one chosen is added to the selection as a tag. */
export function PermissionPicker({ id, label, options, selected, onChange }: {
  id: string;
  label: string;
  options: GrantablePermission[];
  selected: string[];
  onChange: (permissions: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const matches = options.filter(({ permission }) => !selected.includes(permission) && permission.toLowerCase().includes(search));

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {selected.length > 0 ? (
        <div className="picker-tags">
          {selected.map((permission) => (
            <span className="picker-tag" key={permission}>
              <code>{permission}</code>
              <button type="button" aria-label={`Unselect ${permission}`} onClick={() => onChange(selected.filter((held) => held !== permission))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <SearchCombobox
        id={id}
        label={label}
        placeholder="Search permissions"
        query={query}
        onQueryChange={setQuery}
        items={matches}
        keyOf={(option) => option.permission}
        renderItem={({ permission, scope }) => (
          <>
            <code>{permission}</code>
            <span className="meta">{SCOPE_LABELS[scope]}</span>
          </>
        )}
        onSelect={({ permission }) => {
          onChange([...selected, permission]);
          setQuery('');
        }}
        onBackspaceWhenEmpty={() => onChange(selected.slice(0, -1))}
        emptyMessage={options.length === selected.length ? 'All selected.' : 'No permission matches this search.'}
      />
    </div>
  );
}
