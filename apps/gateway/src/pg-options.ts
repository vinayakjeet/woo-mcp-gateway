// A hung Postgres must fail requests, not queue them: the pool is small and shared by auth and audit.
export const PG_CONNECT_TIMEOUT_MS = 2000;
export const PG_QUERY_TIMEOUT_MS = 5000;
