import { createHmac, randomInt } from 'node:crypto';

export interface OAuthInput {
  method: string;
  url: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  nonce: string;
  timestamp: number;
}

// PHP rawurlencode also encodes !'()*, and WooCommerce verifies with it.
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function oauthParams(i: OAuthInput): Record<string, string> {
  return {
    ...i.query,
    oauth_consumer_key: i.consumerKey,
    oauth_nonce: i.nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(i.timestamp),
  };
}

// Mirrors WC_REST_Authentication::check_oauth_signature: sort raw keys, encode key and value, then encode each pair again.
export function oauthBaseString(i: OAuthInput): string {
  const params = oauthParams(i);
  const pairs = Object.keys(params)
    .sort()
    .map((k) => rfc3986(`${rfc3986(k)}=${rfc3986(params[k] ?? '')}`));
  return `${i.method.toUpperCase()}&${rfc3986(i.url)}&${pairs.join('%26')}`;
}

export function signedQuery(i: OAuthInput): Record<string, string> {
  const signature = createHmac('sha256', `${i.consumerSecret}&`)
    .update(oauthBaseString(i))
    .digest('base64');
  return { ...oauthParams(i), oauth_signature: signature };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newNonce(): string {
  return Array.from({ length: 32 }, () => ALNUM[randomInt(ALNUM.length)]).join('');
}
