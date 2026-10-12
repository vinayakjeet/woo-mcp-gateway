// Shared by every Fastify service so a new service cannot forget to hide credentials.
export const LOG_REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-internal-secret"]',
  'res.headers["set-cookie"]',
];

const CODE = /^[A-Za-z0-9_]{1,40}$/;

// Drizzle puts the SQL and its params in the message of a failed query, so messages are never logged.
// The code (a Postgres SQLSTATE or a Node errno name) sits on the error or down its cause chain.
export function errorCode(err: unknown): string {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return 'unknown';
}
