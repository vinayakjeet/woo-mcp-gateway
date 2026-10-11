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
  and .kind == "store" and .managed == true and .protocolMode == "auto" and .auth.type == "bearer" and .auth.secret == "test-token"' \
  <<<"$seed" >/dev/null || fail "seed server main"
jq -e --arg t "$fxtoken" '.[] | select(.slug == "fx") | .kind == "system" and .managed == true and .protocolMode == "auto"
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

# Counts of a pattern in one rendered file.
count() { grep -c -- "$2" <<<"$1" || true; }

cp=$(show control-plane.yaml)
for want in "kind: ServiceAccount" "name: control-plane" "name: control-plane-internal" "port: 3000" "port: 3001" \
  "name: migrate" "- node" "- dist/migrate.js" "key: SEED_SERVERS" "name: platform-seed" "key: KEK" "name: platform-crypto" \
  "key: ADMIN_EMAIL" "key: ADMIN_PASSWORD" "key: API_KEY_PEPPER" "key: JWT_SIGNING_KEY" "key: INTERNAL_SECRET" \
  "key: DATABASE_URL" "name: APP_ORIGIN" "value: \"http://app.127.0.0.1.nip.io\"" \
  "serviceAccountName: control-plane" "automountServiceAccountToken: false" \
  "path: /readyz" "path: /healthz" "containerPort: 3000" "containerPort: 3001" \
  "cpu: 50m" "memory: 128Mi" "cpu: 500m" "memory: 384Mi" "checksum/seed:" \
  "app.kubernetes.io/name: control-plane" "app.kubernetes.io/component: control-plane"; do
  has "$cp" "$want" control-plane
done
# Probes target the internal port so the public listener stays free of health routes.
probe_port() { grep -A2 "$2:" <<<"$1" | grep -o 'port: [0-9]*' | head -1 | cut -d' ' -f2; }
[ "$(probe_port "$cp" readinessProbe)" = "3001" ] || fail "control-plane readiness port"
[ "$(probe_port "$cp" livenessProbe)" = "3001" ] || fail "control-plane liveness port"
lacks "$cp" "app.kubernetes.io/name: gateway" control-plane
# The API token is mounted only once the provisioner (M5) needs the Kubernetes API.
lacks "$cp" "automountServiceAccountToken: true" control-plane
has "$(show control-plane.yaml --set provisioner.enabled=true)" "automountServiceAccountToken: true" "control-plane with provisioner"
pass "control-plane"

gw=$(show gateway.yaml)
for want in "app.kubernetes.io/name: gateway" "containerPort: 9090" "path: /readyz" "path: /healthz" \
  "automountServiceAccountToken: false" "name: POD_NAME" "fieldPath: metadata.name" "key: DATABASE_URL" \
  "cpu: 50m" "memory: 128Mi" "cpu: \"1\"" "memory: 384Mi"; do
  has "$gw" "$want" gateway
done
[ "$(probe_port "$gw" readinessProbe)" = "9090" ] || fail "gateway readiness port"
[ "$(probe_port "$gw" livenessProbe)" = "9090" ] || fail "gateway liveness port"
pass "gateway"

fx=$(show fx-mcp.yaml)
for want in "image: fx-mcp:dev" "name: fx-mcp" "port: 8080" "path: /readyz" "path: /healthz" \
  "name: fx-mcp-token" "key: MCP_SHARED_TOKEN" "automountServiceAccountToken: false" \
  "cpu: 20m" "memory: 64Mi" "cpu: 200m" "memory: 128Mi" "app.kubernetes.io/component: fx-mcp"; do
  has "$fx" "$want" fx-mcp
done
lacks "$fx" "test-token" fx-mcp
pass "fx-mcp"

np=$(show networkpolicy-fx-mcp.yaml)
for want in "kind: NetworkPolicy" "policyTypes:" "- Egress" "kubernetes.io/metadata.name: kube-system" \
  "app.kubernetes.io/name: fx-mcp" "cidr: 0.0.0.0/0" "port: 443" \
  "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16" "100.64.0.0/10"; do
  has "$np" "$want" fx-mcp-netpol
done
[ "$(count "$np" 'port: 53')" -eq 2 ] || fail "fx-mcp-netpol: port 53 must appear for UDP and TCP"
has "$np" "protocol: UDP" fx-mcp-netpol
has "$np" "protocol: TCP" fx-mcp-netpol
lacks "$np" "Ingress" fx-mcp-netpol
pass "fx-mcp networkpolicy"

# No policy selects every pod in the namespace (default-deny is M10).
lacks "$(render | awk 'BEGIN{RS="---\n"} /kind: NetworkPolicy/')" "podSelector: {}" "netpol"
pass "no empty podSelector"

# Every workload file: one probe pair per Deployment or StatefulSet, and the pod and container hardening.
for f in postgres control-plane gateway fx-mcp; do
  y=$(show "$f.yaml")
  [ "$(grep -cE '^kind: (Deployment|StatefulSet)$' <<<"$y")" -eq 1 ] || fail "$f: expected one workload"
  [ "$(count "$y" 'readinessProbe:')" -eq 1 ] || fail "$f: readinessProbe count"
  [ "$(count "$y" 'livenessProbe:')" -eq 1 ] || fail "$f: livenessProbe count"
  [ "$(count "$y" 'runAsNonRoot: true')" -eq 1 ] || fail "$f: runAsNonRoot count"
  [ "$(count "$y" 'type: RuntimeDefault')" -eq 1 ] || fail "$f: seccompProfile count"
  per=$(count "$y" 'allowPrivilegeEscalation: false')
  [ "$per" -ge 1 ] || fail "$f: allowPrivilegeEscalation"
  [ "$(count "$y" '        - ALL\|- ALL')" -eq "$per" ] || fail "$f: drop ALL must match each container"
  # limits: only appears on containers (the PVC template has its own resources key).
  [ "$(count "$y" 'limits:')" -eq "$per" ] || fail "$f: limits must match each container"
done
pass "workload hardening counts"

for f in control-plane gateway fx-mcp; do
  y=$(show "$f.yaml")
  per=$(count "$y" 'allowPrivilegeEscalation: false')
  [ "$(count "$y" 'readOnlyRootFilesystem: true')" -eq "$per" ] || fail "$f: readOnlyRootFilesystem on every container"
  [ "$(count "$y" 'runAsUser: 10001')" -eq 1 ] || fail "$f: runAsUser"
  has "$y" "mountPath: /tmp" "$f"
  has "$y" "emptyDir: {}" "$f"
done
[ "$(count "$cp" 'allowPrivilegeEscalation: false')" -eq 2 ] || fail "control-plane: migrate and main containers"
pass "node containers read-only with /tmp"

ig=$(show ingress-app.yaml)
for want in "ingressClassName: traefik" "host: app.127.0.0.1.nip.io" "path: /api" "name: control-plane" "number: 3000"; do
  has "$ig" "$want" ingress
done
lacks "$ig" "tls:" ingress
pass "ingress"

all_notes=$(helm install platform charts/platform -n platform -f deploy/values-local.yaml --set mcp.sharedToken=test-token --dry-run=client 2>&1 || true)
has "$all_notes" "http://app.127.0.0.1.nip.io" notes
has "$all_notes" "admin@example.com" notes
has "$all_notes" "kubectl -n platform get secret platform-bootstrap -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d" notes
pass "notes"

{ render --set global.imageTag=latest 2>&1 || true; } | grep -q "global.imageTag must not be latest" || fail "imageTag latest accepted"
pass "imageTag latest rejected"


echo "OK"
