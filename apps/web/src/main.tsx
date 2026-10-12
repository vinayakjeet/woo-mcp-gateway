import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { ApiError } from './api';
import './index.css';
import { router } from './router';

// A session that ends mid-use sends the user to sign in. Shell handles the me query without a
// reload, and the sign-in and invite pages show their own 401s (a wrong password, for example).
const onError = (err: unknown, key?: readonly unknown[]) => {
  if (!(err instanceof ApiError) || err.status !== 401 || key?.[0] === 'me') return;
  if (/^\/(login|invite\/)/.test(window.location.pathname)) return;
  window.location.assign('/login');
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => onError(err, query.queryKey) }),
  mutationCache: new MutationCache({ onError: (err) => onError(err) }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
