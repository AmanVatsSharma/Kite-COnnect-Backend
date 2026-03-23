import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useAuthAlert } from '../hooks/useAuthAlert';
import { isApiError } from '../lib/api-client';

function QueryUnauthorizedBridge() {
  const client = useQueryClient();
  const { setUnauthorized } = useAuthAlert();

  useEffect(() => {
    const onQueryEvent = () => {
      const queries = client.getQueryCache().getAll();
      for (const q of queries) {
        const err = q.state.error;
        if (q.state.status === 'error' && err && isApiError(err) && err.status === 401) {
          setUnauthorized(true);
          return;
        }
      }
    };
    const onMutationEvent = () => {
      const mutations = client.getMutationCache().getAll();
      for (const m of mutations) {
        const err = m.state.error;
        if (m.state.status === 'error' && err && isApiError(err) && err.status === 401) {
          setUnauthorized(true);
          return;
        }
      }
    };
    const unsubQ = client.getQueryCache().subscribe(onQueryEvent);
    const unsubM = client.getMutationCache().subscribe(onMutationEvent);
    return () => {
      unsubQ();
      unsubM();
    };
  }, [client, setUnauthorized]);

  return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  );

  return (
    <QueryClientProvider client={client}>
      <QueryUnauthorizedBridge />
      {children}
    </QueryClientProvider>
  );
}
