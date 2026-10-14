import { describe, expect, it } from 'vitest';
import {
  parseStoreDefaults,
  provisionerConfig,
  storeLabels,
  storeMcpUrl,
  storeNamespace,
  storeUrl,
  storeValues,
} from './store-values.js';
import { TEST_STORE_DEFAULTS_JSON, testStoreDefaults } from './test-stores.js';

describe('parseStoreDefaults', () => {
  it('parses what the platform chart renders', () => {
    expect(testStoreDefaults().global).toEqual({
      domain: '127.0.0.1.nip.io',
      scheme: 'http',
      imageTag: 'dev',
    });
  });
  it('refuses latest and a missing class, naming paths only', () => {
    const bad = JSON.parse(TEST_STORE_DEFAULTS_JSON);
    bad.global.imageTag = 'latest';
    delete bad.storage.className;
    let msg = '';
    try {
      parseStoreDefaults(JSON.stringify(bad));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('global.imageTag');
    expect(msg).toContain('storage.className');
    expect(msg).not.toContain('latest');
  });
  it('refuses text that is not JSON', () => {
    expect(() => parseStoreDefaults('{')).toThrow('PROVISIONER_STORE_VALUES invalid: not JSON');
  });
});

describe('store names and generated values', () => {
  const d = testStoreDefaults();
  it('builds the namespace and URLs, and labels the namespace to enforce and warn restricted', () => {
    expect(storeNamespace('second-store')).toBe('store-second-store');
    expect(storeUrl(d, 'second-store')).toBe('http://second-store.shop.127.0.0.1.nip.io');
    expect(storeMcpUrl('second-store')).toBe(
      'http://woo-mcp.store-second-store.svc.cluster.local:8080/mcp',
    );
    expect(storeLabels('second-store')).toEqual({
      'urumi.io/store': 'second-store',
      'urumi.io/managed': 'true',
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/warn': 'restricted',
    });
  });
  it('writes JSON values that keep any store name intact', () => {
    const name = `Bob's "Shop": #1 {x} - [y]`;
    const v = JSON.parse(storeValues(d, { slug: 'bob-s-shop-1', name }, 'tok'));
    expect(v).toMatchObject({
      slug: 'bob-s-shop-1',
      storeName: name,
      mcp: { sharedToken: 'tok' },
      global: { domain: '127.0.0.1.nip.io', scheme: 'http', imageTag: 'dev' },
      storage: { className: 'local-path', mariadb: '2Gi', wordpress: '2Gi' },
      ingress: { className: 'traefik' },
    });
  });
});

describe('provisionerConfig', () => {
  const on = { PROVISIONER_ENABLED: 'true', PROVISIONER_STORE_VALUES: TEST_STORE_DEFAULTS_JSON };
  it('is null unless enabled', () => {
    expect(provisionerConfig({})).toBeNull();
    expect(provisionerConfig({ PROVISIONER_ENABLED: 'false' })).toBeNull();
  });
  it('defaults the limit to 3 and reads an override', () => {
    expect(provisionerConfig(on)?.maxStoresPerUser).toBe(3);
    expect(
      provisionerConfig({ ...on, PROVISIONER_MAX_STORES_PER_USER: '2' })?.maxStoresPerUser,
    ).toBe(2);
  });
  it('fails without store values or with a bad limit', () => {
    expect(() => provisionerConfig({ PROVISIONER_ENABLED: 'true' })).toThrow(
      'PROVISIONER_STORE_VALUES',
    );
    expect(() => provisionerConfig({ ...on, PROVISIONER_MAX_STORES_PER_USER: '0' })).toThrow(
      'positive integer',
    );
  });
});
