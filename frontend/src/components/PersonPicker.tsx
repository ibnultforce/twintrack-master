'use client';

import { useEffect, useState } from 'react';
import type { AddablePerson } from '@/lib/api/types';
import { listAddablePeople } from '@/lib/api/users';
import { useLoad } from '@/lib/useLoad';
import { SearchCombobox } from './SearchCombobox';

const SEARCH_DELAY_MS = 250;

/** Picks one person who can be added to a module, searching on the server because the list can be long. */
export function PersonPicker({ id, label, moduleKey, selected, onChange }: {
  id: string;
  label: string;
  moduleKey: string;
  selected: AddablePerson | null;
  onChange: (person: AddablePerson | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useLoad(() => listAddablePeople(moduleKey, search), [moduleKey, search]);

  function emptyMessage(): string {
    if (results.error) return results.error;
    if (!results.data) return 'Loading…';
    return search ? 'Nobody matches this search.' : 'Everyone already has access to this module.';
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {selected ? (
        <div className="picker-tags">
          <span className="picker-tag">
            {selected.name}
            <button type="button" aria-label={`Unselect ${selected.name}`} onClick={() => onChange(null)}>×</button>
          </span>
        </div>
      ) : (
        <SearchCombobox
          id={id}
          label={label}
          placeholder="Search name, email, title"
          query={query}
          onQueryChange={setQuery}
          items={results.data?.people ?? []}
          keyOf={(person) => person.id}
          renderItem={(person) => (
            <>
              <span>
                <span className="strong">{person.name}</span>
                <span className="meta"> {person.email}</span>
              </span>
              {person.title ? <span className="meta">{person.title}</span> : null}
            </>
          )}
          onSelect={(person) => {
            onChange(person);
            setQuery('');
          }}
          emptyMessage={emptyMessage()}
        />
      )}
    </div>
  );
}
