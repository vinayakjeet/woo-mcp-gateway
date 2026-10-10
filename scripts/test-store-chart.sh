#!/usr/bin/env bash
# Static checks on the rendered store chart. Needs helm only, no cluster.
# lookup returns nothing without a cluster, so every Secret value here is freshly generated.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

render() {
  helm template store-main charts/store --namespace store-main \
    -f deploy/store-values-local.yaml --set slug=main --set-string storeName="Main Store" "$@"
}
show() { render --show-only "templates/$1" "${@:2}"; }
has() { grep -qF -- "$2" <<<"$1" || fail "$3: missing '$2'"; }
lacks() { if grep -qF -- "$2" <<<"$1"; then fail "$3: unexpected '$2'"; fi; }
secret_value() { # rendered yaml, key
  sed -n "s/^  $2: \"\(.*\)\"$/\1/p" <<<"$1" | base64 -d
}

helm lint charts/store -f deploy/store-values-local.yaml --set slug=main >/dev/null || fail "helm lint"
pass "helm lint"

all=$(render)
lacks "$all" ":latest" "all"
pass "no latest tags"

s=$(show secrets.yaml)
for name in store-db store-wp store-wc-api; do
  has "$s" "name: $name" secrets
done
has "$s" "helm.sh/resource-policy: keep" secrets
for key in MARIADB_ROOT_PASSWORD MARIADB_PASSWORD WP_ADMIN_USER WP_ADMIN_PASSWORD WORDPRESS_AUTH_KEY WORDPRESS_NONCE_SALT; do
  has "$s" "  $key: " secrets
done
secret_value "$s" WC_CONSUMER_KEY | grep -Eqx 'ck_[0-9a-f]{40}' || fail "WC_CONSUMER_KEY format"
secret_value "$s" WC_CONSUMER_SECRET | grep -Eqx 'cs_[0-9a-f]{40}' || fail "WC_CONSUMER_SECRET format"
lacks "$s" "name: store-mcp-token" "secrets without token"
has "$(show secrets.yaml --set mcp.sharedToken=test-token)" "name: store-mcp-token" "secrets with token"
pass "secrets"

pod_checks() { # rendered yaml, uid, label
  local y=$1
  for want in "runAsNonRoot: true" "runAsUser: $2" "type: RuntimeDefault" \
    "automountServiceAccountToken: false" "allowPrivilegeEscalation: false" "- ALL" \
    "requests:" "limits:"; do
    has "$y" "$want" "$3"
  done
}

m=$(show mariadb.yaml)
pod_checks "$m" 999 mariadb
for want in "kind: StatefulSet" "serviceName: mariadb-headless" "image: mariadb:11.4.13" \
  "clusterIP: None" "name: mariadb-headless" "port: 3306" \
  "cpu: 100m" "memory: 256Mi" "cpu: \"1\"" "memory: 768Mi" \
  "- --innodb_initialized" "storageClassName: local-path" "storage: 2Gi" \
  "failureThreshold: 30" "fsGroup: 999"; do
  has "$m" "$want" mariadb
done
pass "mariadb"

echo "OK"
