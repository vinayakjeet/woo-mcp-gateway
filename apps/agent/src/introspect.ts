import { z } from 'zod';

const INTROSPECT_TIMEOUT_MS = 5000;

const sessionSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable(),
    role: z.enum(['admin', 'member']),
  }),
  token: z.string().min(1),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

// SPEC 7: the browser's Cookie header goes to the control-plane unchanged. Null means no live session.
export async function introspect(o: {
  baseUrl: string;
  secret: string;
  cookie: string;
  fetch?: typeof fetch;
}): Promise<SessionInfo | null> {
  const res = await (o.fetch ?? fetch)(`${o.baseUrl}/internal/sessions/introspect`, {
    method: 'POST',
    headers: { 'x-internal-secret': o.secret, cookie: o.cookie },
    signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
  });
  if (res.status === 401) return null;
  // The code lands in the log through errorCode, so a wrong secret shows as HTTP_403.
  if (!res.ok)
    throw Object.assign(new Error('session introspection failed'), { code: `HTTP_${res.status}` });
  return sessionSchema.parse(await res.json());
}
