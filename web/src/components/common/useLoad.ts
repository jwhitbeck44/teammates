import { useCallback, useEffect, useState } from 'react';
import { StudentApiError } from '../../api/student';
import { mapRpcError, MappedError } from '../../lib/studentView';

export interface LoadState<T> {
  data: T | null;
  error: MappedError | null;
  loading: boolean;
  reload: () => void;
}

/** Run an async loader on mount and when `deps` change. Errors are mapped for display. */
export default function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<MappedError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader().then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        const mapped: MappedError =
          e instanceof StudentApiError
            ? { code: e.code, message: e.message, recipient_key: e.recipient_key }
            : mapRpcError(e);
        setError(mapped);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
