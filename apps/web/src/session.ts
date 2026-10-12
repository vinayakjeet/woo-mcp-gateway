import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Config, Me } from './types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: Me }>('/api/me').then((r) => r.user),
    staleTime: 60_000,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api<Config>('/api/config'),
    staleTime: Infinity,
  });
}
