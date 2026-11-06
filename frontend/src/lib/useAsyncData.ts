import { useCallback, useEffect, useState } from 'react';

interface AsyncData<Data> {
  data: Data | undefined;
  error: unknown;
  isLoading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever it changes, so wrap it in useCallback. Late answers to old requests are ignored. */
export function useAsyncData<Data>(load: () => Promise<Data>): AsyncData<Data> {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<unknown>();
  const [isLoading, setIsLoading] = useState(true);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    load()
      .then((result) => {
        if (!isCurrent) return;
        setData(result);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (isCurrent) setError(caught);
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [load, reloadCount]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  return { data, error, isLoading, reload };
}
