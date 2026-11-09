'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';

/** A search box that opens a list on focus. The parent decides what the list holds and what choosing an item does. */
export function SearchCombobox<Item>({ id, label, placeholder, query, onQueryChange, items, keyOf, renderItem, onSelect, onBackspaceWhenEmpty, emptyMessage }: {
  id: string;
  label: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  items: Item[];
  keyOf: (item: Item) => string;
  renderItem: (item: Item) => ReactNode;
  onSelect: (item: Item) => void;
  onBackspaceWhenEmpty?: () => void;
  emptyMessage: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const highlightedIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));
  const highlighted = isOpen ? items[highlightedIndex] : undefined;
  const listId = `${id}-list`;
  const optionId = (item: Item) => `${id}-option-${keyOf(item)}`;

  const choose = (item: Item) => {
    onSelect(item);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Inside a dialog, Escape should close only this list while it's open.
      if (isOpen) {
        event.stopPropagation();
        event.preventDefault();
      }
      setIsOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else if (items.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((highlightedIndex + step + items.length) % items.length);
      }
    } else if (event.key === 'Enter' && highlighted !== undefined) {
      event.preventDefault();
      choose(highlighted);
    } else if (event.key === 'Backspace' && query === '') {
      onBackspaceWhenEmpty?.();
    }
  };

  return (
    <div className="picker">
      <input
        className="input"
        id={id}
        type="search"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={highlighted !== undefined ? optionId(highlighted) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setActiveIndex(0);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onClick={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        onKeyDown={handleKeyDown}
      />
      {isOpen ? (
        // Stops the mouse press from taking focus off the search box, which would close the list before the click lands.
        <ul className="picker-list" id={listId} role="listbox" aria-label={label} onMouseDown={(event) => event.preventDefault()}>
          {items.length === 0 ? <li className="picker-empty">{emptyMessage}</li> : null}
          {items.map((item, index) => (
            <li
              key={keyOf(item)}
              id={optionId(item)}
              className="picker-option"
              role="option"
              aria-selected={index === highlightedIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(item)}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
