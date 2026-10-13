import { parseStoreDefaults, type StoreDefaults } from './store-values.js';

// What charts/platform renders into PROVISIONER_STORE_VALUES with deploy/values-local.yaml.
export const TEST_STORE_DEFAULTS_JSON = JSON.stringify({
  global: { domain: '127.0.0.1.nip.io', scheme: 'http', imageTag: 'dev' },
  images: { registry: '' },
  ingress: { className: 'traefik', tls: { enabled: false, clusterIssuer: '' } },
  storage: { className: 'local-path', mariadb: '2Gi', wordpress: '2Gi' },
  wordpress: { environmentType: 'local' },
});

export function testStoreDefaults(): StoreDefaults {
  return parseStoreDefaults(TEST_STORE_DEFAULTS_JSON);
}
