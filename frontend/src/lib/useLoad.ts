'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeError } from './api/http';

export interface LoadState<Data> {
  data?: Data;
  error?: string;
  isLoading: boolean;
  reload: () => void;
}

interface LoadResult<Data> {
  data?: Data;
  error?: string;
  isLoading: boolean;
  owner?: unknown;
}

/**
 * Runs a loader when its dependencies change. Earlier data stays on screen during a reload, and late answers are ignored.
 * Pass `owner` when the data belongs to one thing, such as a module, so it's never shown or used under a different one.
 */
export function useLoad<Data>(loader: () => Promise<Data>, dependencies: unknown[], owner?: unknown): LoadState<Data> {
  const [result, setResult] = useState<LoadResult<Data>>({ isLoading: true, owner });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    setResult((previous) => ({ ...previous, error: undefined, isLoading: true }));
    loader().then(
      (data) => {
        if (isCurrent) setResult({ data, isLoading: false, owner });
      },
      (error: unknown) => {
        if (isCurrent) {
          setResult((previous) => ({ data: previous.owner === owner ? previous.data : undefined, error: describeError(error), isLoading: false, owner }));
        }
      },
    );
    return () => {
      isCurrent = false;
    };
    // The caller lists what the loader depends on, the same way it would for useEffect.
  }, [version, ...dependencies]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  if (result.owner !== owner) return { isLoading: true, reload };
  return { data: result.data, error: result.error, isLoading: result.isLoading, reload };
}
