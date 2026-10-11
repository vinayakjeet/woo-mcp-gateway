import { ProtocolError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { errorCode } from '@woo/core';
import type { ErrorKind, Failure } from './types.js';

const DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
const TIMEOUT = new Set<string>([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'TimeoutError',
  SdkErrorCode.RequestTimeout,
]);
const TLS = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/;
const PROTOCOL = new Set<string>([
  SdkErrorCode.InvalidResult,
  SdkErrorCode.UnsupportedResultType,
  SdkErrorCode.ClientHttpUnexpectedContent,
  'SyntaxError',
]);

const failure = (kind: ErrorKind, message: string): Failure => ({ kind, message });

// Messages come from codes and status numbers only. An upstream error body or message can echo
// the credential the gateway sent, so no text from the error itself leaves this function.
export function classifyError(err: unknown): Failure {
  const codes: string[] = [];
  let status: number | undefined;
  let rpcCode: number | undefined;
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur !== null && typeof cur === 'object'; depth++) {
    if (cur instanceof SdkHttpError) status ??= cur.status;
    if (cur instanceof ProtocolError) rpcCode ??= cur.code;
    const { code, name } = cur as { code?: unknown; name?: unknown };
    if (typeof code === 'string') codes.push(code);
    if (typeof name === 'string') codes.push(name);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (codes.some((c) => DNS.has(c))) return failure('dns', 'DNS lookup failed');
  if (codes.some((c) => REFUSED.has(c))) return failure('refused', 'connection refused');
  if (codes.some((c) => TLS.test(c))) return failure('tls', 'TLS handshake failed');
  if (codes.some((c) => TIMEOUT.has(c))) return failure('timeout', 'no answer in time');
  if (status === 401) return failure('http_401', 'HTTP 401');
  if (status === 403) return failure('http_403', 'HTTP 403');
  if (status === 404) return failure('http_404', 'HTTP 404');
  if (status !== undefined && status >= 500) return failure('http_5xx', `HTTP ${status}`);
  if (status !== undefined) return failure('protocol', `HTTP ${status}`);
  if (rpcCode !== undefined) return failure('protocol', `JSON-RPC error ${rpcCode}`);
  if (codes.some((c) => PROTOCOL.has(c))) return failure('protocol', 'invalid response');
  return failure('unknown', `unexpected error (${errorCode(err)})`);
}
