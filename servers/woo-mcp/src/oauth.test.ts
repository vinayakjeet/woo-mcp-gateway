import { describe, expect, it } from 'vitest';
import { newNonce, oauthBaseString, rfc3986, signedQuery, type OAuthInput } from './oauth.js';

const base = {
  consumerKey: 'ck_0123456789abcdef0123456789abcdef01234567',
  consumerSecret: 'cs_fedcba9876543210fedcba9876543210fedcba98',
  nonce: 'abcdefghijklmnopqrstuvwxyz012345',
  timestamp: 1791676800,
};

describe('rfc3986', () => {
  it('encodes the characters PHP rawurlencode encodes and encodeURIComponent does not', () => {
    expect(rfc3986("a b!'()*~-._")).toBe('a%20b%21%27%28%29%2A~-._');
  });
});

describe('WooCommerce vectors', () => {
  it('signs a request without query params', () => {
    const i: OAuthInput = { ...base, method: 'GET', url: 'http://main.shop.127.0.0.1.nip.io/wp-json/wc/v3/products', query: {} };
    expect(oauthBaseString(i)).toBe(
      'GET&http%3A%2F%2Fmain.shop.127.0.0.1.nip.io%2Fwp-json%2Fwc%2Fv3%2Fproducts&oauth_consumer_key%3Dck_0123456789abcdef0123456789abcdef01234567%26oauth_nonce%3Dabcdefghijklmnopqrstuvwxyz012345%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1791676800',
    );
    expect(signedQuery(i).oauth_signature).toBe('7BcNRlMZAK77rih1BbRGKf7TvefbCDXMTF/KBdfJ/Kk=');
  });

  it('signs query params with reserved characters', () => {
    const i: OAuthInput = {
      ...base,
      method: 'GET',
      url: 'http://main.shop.127.0.0.1.nip.io/wp-json/wc/v3/orders',
      query: { search: "blue shirt (men's)!*", per_page: '20', after: '2026-10-11T00:00:00+05:30' },
    };
    expect(oauthBaseString(i)).toBe(
      'GET&http%3A%2F%2Fmain.shop.127.0.0.1.nip.io%2Fwp-json%2Fwc%2Fv3%2Forders&after%3D2026-10-11T00%253A00%253A00%252B05%253A30%26oauth_consumer_key%3Dck_0123456789abcdef0123456789abcdef01234567%26oauth_nonce%3Dabcdefghijklmnopqrstuvwxyz012345%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1791676800%26per_page%3D20%26search%3Dblue%2520shirt%2520%2528men%2527s%2529%2521%252A',
    );
    const q = signedQuery(i);
    expect(q.oauth_signature).toBe('P6qnVO6jcWpY9bXVtLAyKX6Sk2rGdNpgfspYKjo0Zts=');
    expect(q.search).toBe("blue shirt (men's)!*");
    expect(q.oauth_signature_method).toBe('HMAC-SHA256');
  });
});

describe('newNonce', () => {
  it('is 32 alphanumeric chars and differs between calls', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});
