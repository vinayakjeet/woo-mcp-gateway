#!/usr/bin/env bash
# Static checks on the rendered platform chart. Needs helm and jq, no cluster.
# lookup returns nothing without a cluster, so every Secret value here is freshly generated.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

render() {
  helm template platform charts/platform --namespace platform \
    -f deploy/values-local.yaml --set mcp.sharedToken=test-token "$@"
}
show() { render --show-only "templates/$1" "${@:2}"; }
has() { grep -qF -- "$2" <<<"$1" || fail "$3: missing '$2'"; }
lacks() { if grep -qF -- "$2" <<<"$1"; then fail "$3: unexpected '$2'"; fi; }
# One Secret document out of a multi-document render, by name.
doc() { awk -v n="  name: $2" 'BEGIN{RS="---\n"} index($0, n "\n") && /kind: Secret/' <<<"$1"; }
secret_value() { # secret document, key
  sed -n "s/^  $2: \"\(.*\)\"$/\1/p" <<<"$1" | base64 -d
}

helm lint charts/platform -f deploy/values-local.yaml --set mcp.sharedToken=test-token >/dev/null || fail "helm lint"
pass "helm lint"

all=$(render)
lacks "$all" ":latest" "all"
pass "no latest tags"

s=$(show secrets.yaml)
for name_keys in \
  "platform-db POSTGRES_PASSWORD DATABASE_URL" \
  "platform-crypto KEK API_KEY_PEPPER JWT_SIGNING_KEY INTERNAL_SECRET" \
  "platform-bootstrap ADMIN_EMAIL ADMIN_PASSWORD" \
  "platform-seed SEED_SERVERS" \
  "fx-mcp-token MCP_SHARED_TOKEN"; do
  read -r name keys <<<"$name_keys"
  d=$(doc "$s" "$name")
  [ -n "$d" ] || fail "secrets: no Secret $name"
  for key in $keys; do
    has "$d" "  $key: " "secret $name"
  done
done
pass "secret names and keys"

[ "$(secret_value "$(doc "$s" platform-crypto)" KEK | base64 -d | wc -c)" -eq 32 ] || fail "KEK is not 32 bytes of base64"
pass "KEK decodes to 32 bytes"

pw=$(secret_value "$(doc "$s" platform-db)" POSTGRES_PASSWORD)
[ -n "$pw" ] || fail "empty POSTGRES_PASSWORD"
has "$(secret_value "$(doc "$s" platform-db)" DATABASE_URL)" "$pw" "DATABASE_URL"
pass "DATABASE_URL carries the generated password"

seed=$(secret_value "$(doc "$s" platform-seed)" SEED_SERVERS)
fxtoken=$(secret_value "$(doc "$s" fx-mcp-token)" MCP_SHARED_TOKEN)
[ -n "$fxtoken" ] || fail "empty fx token"
jq -e '.[] | select(.slug == "main") | .url == "http://woo-mcp.store-main.svc.cluster.local:8080/mcp"
  and .kind == "store" and .managed == true and .auth.type == "bearer" and .auth.secret == "test-token"' \
  <<<"$seed" >/dev/null || fail "seed server main"
jq -e --arg t "$fxtoken" '.[] | select(.slug == "fx") | .kind == "system" and .managed == true
  and .auth.type == "bearer" and .auth.secret == $t and .url == "http://fx-mcp.platform.svc.cluster.local:8080/mcp"' \
  <<<"$seed" >/dev/null || fail "seed server fx"
[ "$(jq length <<<"$seed")" -eq 2 ] || fail "seed server count"
pass "seed servers"

# Captured first: grep -q would close the pipe early and helm would exit with SIGPIPE under pipefail.
if err=$(helm template x charts/platform -n platform -f deploy/values-local.yaml 2>&1 >/dev/null); then
  fail "render without mcp.sharedToken must fail"
fi
has "$err" "deploy/secrets/store-main.yaml" "sharedToken message"
pass "sharedToken required, message names the file"

# Existing values must survive a second install. platform-seed has no random value of its own:
# it reuses the fx token read back through lookup.
[ "$(grep -c 'lookup "v1" "Secret"' charts/platform/templates/secrets.yaml)" -eq 4 ] || fail "lookup count"
for name in platform-db platform-crypto platform-bootstrap; do
  has "$(doc "$s" "$name")" "helm.sh/resource-policy: keep" "secret $name"
done
pass "secrets read through lookup and kept on uninstall"

p=$(show postgres.yaml)
for want in "kind: StatefulSet" "serviceName: postgres-headless" "name: postgres-headless" "clusterIP: None" \
  "image: postgres:17-alpine" "port: 5432" "runAsNonRoot: true" "runAsUser: 70" "runAsGroup: 70" "fsGroup: 70" \
  "type: RuntimeDefault" "allowPrivilegeEscalation: false" "- ALL" "automountServiceAccountToken: false" \
  "cpu: 100m" "memory: 256Mi" "cpu: \"1\"" "memory: 512Mi" \
  "storageClassName: local-path" "storage: 2Gi" "value: platform" \
  "value: /var/lib/postgresql/data/pgdata" "name: platform-db" "key: POSTGRES_PASSWORD"; do
  has "$p" "$want" postgres
done
# Readiness, liveness and a startup probe (first initdb can outlast the liveness window, as for MariaDB).
[ "$(grep -c -- '- pg_isready' <<<"$p")" -eq 3 ] || fail "postgres: pg_isready must be readiness, liveness and startup"
has "$p" "startupProbe:" postgres
has "$p" "readinessProbe:" postgres
has "$p" "livenessProbe:" postgres
lacks "$p" "readOnlyRootFilesystem" postgres
pass "postgres"

echo "OK"
