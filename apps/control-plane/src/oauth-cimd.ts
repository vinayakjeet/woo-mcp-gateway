import { BLOCKED_CODE, type PinnedFetch } from '@woo/core';
import type pg from 'pg';
import { parseRegistration } from './oauth-clients.js';

// Client ID Metadata Documents (decision 24): a client_id that is an https URL names a JSON
// document the client publishes. We fetch it, so the document is untrusted input from the network.
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5000;
export const MAX_CLIENT_ID_URL = 2000;

export type CimdReason =
  | 'bad_url'
  | 'blocked'
  | 'fetch'
  | 'timeout'
  | 'status'
  | 'content_type'
  | 'too_large'
  | 'not_json'
  | 'client_id_mismatch'
  | 'invalid_metadata';
export type CimdResult =
  { ok: true; name: string; redirectUris: string[] } | { ok: false; reason: CimdReason };

const no = (reason: CimdReason): CimdResult => ({ ok: false, reason });
const JSON_TYPE = /^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/i;

// A DCR client id never starts with https://, so the two kinds cannot be confused.
export const isCimdId = (id: string): boolean => id.startsWith('https://');

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 100);
  } catch {
    return '';
  }
}

// The client id URL rules of the CIMD draft: https, a path, no fragment, no userinfo, no dot
// segments. The URL parser resolves dot segments away, so they are looked for in the raw text.
function validClientIdUrl(raw: string): boolean {
  if (raw.length > MAX_CLIENT_ID_URL || /[\p{Cc}\s]/u.test(raw) || raw.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false;
  if (u.pathname === '/') return false;
  const afterHost = raw.slice('https://'.length).replace(/%2e/gi, '.');
  return !/\/\.{1,2}(?:[/?]|$)/.test(afterHost);
}

function reasonOf(err: unknown, signal: AbortSignal): CimdReason {
  if (signal.aborted) return 'timeout';
  for (let cur = err, i = 0; cur && i < 6; i++, cur = (cur as { cause?: unknown }).cause)
    if ((cur as { code?: unknown }).code === BLOCKED_CODE) return 'blocked';
  return 'fetch';
}

// Rejects when the signal fires. The fetch and the body read race it, so the deadline holds even
// for a fetch that ignores its signal.
function whenAborted(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  p.catch(() => {});
  return p;
}

// Reads at most CIMD_MAX_BYTES and gives up when the signal fires, so a server that sends one byte
// a minute cannot hold the request.
async function readBody(
  res: Response,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; reason: CimdReason }> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: true, text: '' };
  const aborted = whenAborted(signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > CIMD_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    return { ok: false, reason: reasonOf(err, signal) };
  }
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    };
  } catch {
    return { ok: false, reason: 'not_json' };
  }
}

// `fetch` is the pinned fetch from core: it refuses non-public addresses at connect time and
// treats a redirect as an error, so a document can never send us to another host.
export async function fetchClientMetadata(
  url: string,
  o: { fetch: PinnedFetch; timeoutMs?: number },
): Promise<CimdResult> {
  if (!isCimdId(url) || !validClientIdUrl(url)) return no('bad_url');
  const signal = AbortSignal.timeout(o.timeoutMs ?? CIMD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await Promise.race([
      o.fetch(url, { headers: { accept: 'application/json' }, signal }),
      whenAborted(signal),
    ]);
  } catch (err) {
    return no(reasonOf(err, signal));
  }
  const drop = () => void res.body?.cancel().catch(() => {});
  if (res.status !== 200) {
    drop();
    return no('status');
  }
  if (!JSON_TYPE.test(res.headers.get('content-type') ?? '')) {
    drop();
    return no('content_type');
  }
  if (Number(res.headers.get('content-length') ?? 0) > CIMD_MAX_BYTES) {
    drop();
    return no('too_large');
  }
  const body = await readBody(res, signal);
  if (!body.ok) return no(body.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return no('not_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return no('not_json');
  const d = parsed as Record<string, unknown>;
  if (d.client_id !== url) return no('client_id_mismatch');
  // A document cannot ask for a secret: a public URL cannot keep one.
  if ('client_secret' in d || 'client_secret_expires_at' in d) return no('invalid_metadata');
  // The same rules as dynamic registration: redirect URIs, grant and response types, auth method.
  const reg = parseRegistration(d);
  return reg.ok
    ? { ok: true, name: reg.name, redirectUris: reg.redirectUris }
    : no('invalid_metadata');
}

export async function upsertCimdClient(
  pool: pg.Pool,
  url: string,
  doc: { name: string; redirectUris: string[] },
): Promise<void> {
  await pool.query(
    `insert into oauth_clients (client_id, name, redirect_uris, metadata_url)
     values ($1, $2, $3::jsonb, $1)
     on conflict (client_id) do update
       set name = excluded.name, redirect_uris = excluded.redirect_uris, metadata_url = excluded.metadata_url`,
    [url, doc.name, JSON.stringify(doc.redirectUris)],
  );
}
