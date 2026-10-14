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
  "serviceAccountName: control-plane" \
  "path: /readyz" "path: /healthz" "containerPort: 3000" "containerPort: 3001" \
  "cpu: 50m" "memory: 128Mi" "cpu: 500m" "memory: 384Mi" "checksum/seed:" \
  "app.kubernetes.io/name: control-plane" "app.kubernetes.io/component: control-plane" \
  "name: GATEWAY_URL" 'value: "http://mcp.127.0.0.1.nip.io/mcp"' "name: APP_VERSION"; do
  has "$cp" "$want" control-plane
done
# The migrate init container and the API (server secrets) both need the KEK.
[ "$(count "$cp" 'key: KEK')" -eq 2 ] || fail "control-plane: KEK in migrate and main containers"
# Probes target the internal port so the public listener stays free of health routes.
probe_port() { grep -A2 "$2:" <<<"$1" | grep -o 'port: [0-9]*' | head -1 | cut -d' ' -f2; }
[ "$(probe_port "$cp" readinessProbe)" = "3001" ] || fail "control-plane readiness port"
[ "$(probe_port "$cp" livenessProbe)" = "3001" ] || fail "control-plane liveness port"
lacks "$cp" "app.kubernetes.io/name: gateway" control-plane
# values-local turns the provisioner on (M9), which mounts the API token.
has "$cp" "automountServiceAccountToken: true" control-plane
lacks "$(show control-plane.yaml --set provisioner.enabled=false)" "automountServiceAccountToken: true" "control-plane without provisioner"
for want in "name: PROVISIONER_ENABLED" "value: \"true\"" "name: PROVISIONER_MAX_STORES_PER_USER" "value: \"3\"" \
  "name: HOME" "value: /tmp" '\"domain\":\"127.0.0.1.nip.io\"' '\"imageTag\":\"dev\"' \
  '\"className\":\"local-path\"' '\"mariadb\":\"2Gi\"' '\"environmentType\":\"local\"'; do
  has "$cp" "$want" "control-plane provisioner env"
done
[ "$(grep -c 'name: PROVISIONER_STORE_VALUES' <<<"$cp")" -eq 2 ] || fail "PROVISIONER_STORE_VALUES must reach the migrate init container and the app"
rb=$(show rbac-provisioner.yaml)
for want in "kind: ClusterRole" "kind: ClusterRoleBinding" "name: control-plane" "namespace: platform" \
  "- namespaces" "- deployments" "- statefulsets" "- services" "- configmaps" "- secrets" \
  "- persistentvolumeclaims" "- jobs" "- cronjobs" "- ingresses" "- networkpolicies" "- resourcequotas" \
  "- limitranges" "- pods" "- replicasets" "- events"; do
  has "$rb" "$want" rbac
done
if grep -Eq -- '- persistentvolumes$' <<<"$rb"; then fail "rbac: persistentvolumes is not in SPEC 18"; fi
lacks "$rb" "'*'" rbac
if render --set provisioner.enabled=false --show-only templates/rbac-provisioner.yaml >/dev/null 2>&1; then
  fail "rbac rendered with the provisioner off"
fi
pass "control-plane"

gw=$(show gateway.yaml)
for want in "app.kubernetes.io/name: gateway" "containerPort: 9090" "containerPort: 8080" "path: /readyz" "path: /healthz" \
  "automountServiceAccountToken: false" "name: POD_NAME" "fieldPath: metadata.name" "key: DATABASE_URL" \
  "key: KEK" "key: API_KEY_PEPPER" "key: JWT_SIGNING_KEY" "name: platform-crypto" \
  'value: "http://mcp.127.0.0.1.nip.io/mcp"' 'value: "http://app.127.0.0.1.nip.io"' \
  "kind: Service" "port: 8080" "targetPort: http" \
  "cpu: 50m" "memory: 128Mi" "cpu: \"1\"" "memory: 384Mi"; do
  has "$gw" "$want" gateway
done
[ "$(probe_port "$gw" readinessProbe)" = "9090" ] || fail "gateway readiness port"
[ "$(probe_port "$gw" livenessProbe)" = "9090" ] || fail "gateway liveness port"
has "$(show gateway.yaml --set 'gateway.allowedOrigins={https://a.example,https://b.example}')" \
  'value: "https://a.example,https://b.example"' "gateway origins override"
# The gateway connects and the control-plane validates: both must read the one value.
for f in gateway.yaml control-plane.yaml; do
  has "$(show "$f")" 'name: ALLOW_INSECURE_UPSTREAMS' "$f insecure upstreams env"
  [ "$(show "$f" | grep -A1 'name: ALLOW_INSECURE_UPSTREAMS' | sed -n 's/.*value: //p')" = '"false"' ] ||
    fail "$f: ALLOW_INSECURE_UPSTREAMS is not false by default"
  [ "$(show "$f" --set gateway.allowInsecureUpstreams=true | grep -A1 'name: ALLOW_INSECURE_UPSTREAMS' | sed -n 's/.*value: //p')" = '"true"' ] ||
    fail "$f: gateway.allowInsecureUpstreams=true does not reach ALLOW_INSECURE_UPSTREAMS"
done
[ "$(helm template platform charts/platform --namespace platform -f deploy/values-local.yaml --set mcp.sharedToken=x --show-only templates/gateway.yaml | grep -c '"true"')" = 0 ] ||
  fail "values-local.yaml turns on insecure upstreams"
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

na=$(show networkpolicy-agent.yaml)
for want in "name: agent-egress" "app.kubernetes.io/name: agent" "- Egress" \
  "kubernetes.io/metadata.name: kube-system" "port: 53" \
  "app.kubernetes.io/name: gateway" "port: 8080" "app.kubernetes.io/name: control-plane" "port: 3001" \
  "cidr: 0.0.0.0/0" "- 10.0.0.0/8" "- 172.16.0.0/12" "- 192.168.0.0/16" "- 169.254.0.0/16" \
  "- 100.64.0.0/10" "port: 443"; do
  has "$na" "$want" agent-netpol
done
lacks "$na" "Ingress" agent-netpol
lacks "$na" "5432" agent-netpol
pass "agent networkpolicy"

# SPEC 16 default deny: one default-deny and one allow-dns in platform and in mcp-hosted (decision E).
netpols=$(render | awk 'BEGIN{RS="---\n"} /kind: NetworkPolicy/ {print "---"; print}')
npdoc() { awk -v n="  name: $1" 'BEGIN{RS="---\n"} index($0, n "\n") && /kind: NetworkPolicy/' <<<"${2:-$netpols}"; }
for ns in platform mcp-hosted; do
  d=$(awk -v ns="  namespace: $ns" 'BEGIN{RS="---\n"} index($0, "name: default-deny\n") && index($0, ns "\n")' <<<"$netpols")
  [ -n "$d" ] || fail "no default-deny in $ns"
  has "$d" "podSelector: {}" "default-deny $ns"
  has "$d" "- Ingress" "default-deny $ns"
  has "$d" "- Egress" "default-deny $ns"
  lacks "$d" "ingress:" "default-deny $ns"
  lacks "$d" "egress:" "default-deny $ns"
  a=$(awk -v ns="  namespace: $ns" 'BEGIN{RS="---\n"} index($0, "name: allow-dns\n") && index($0, ns "\n")' <<<"$netpols")
  [ -n "$a" ] || fail "no allow-dns in $ns"
  has "$a" "kubernetes.io/metadata.name: kube-system" "allow-dns $ns"
  [ "$(count "$a" 'port: 53')" -eq 2 ] || fail "allow-dns $ns: port 53 for UDP and TCP"
done
[ "$(count "$netpols" 'podSelector: {}')" -eq 4 ] || fail "only default-deny and allow-dns select every pod"
pass "default deny in platform and mcp-hosted"

# One policy per workload and direction. Ports are pod ports (kube-router matches after the Service DNAT).
traefik="kubernetes.io/metadata.name: kube-system"
ingress_policy() { # name, selected pod label, port line
  local d
  d=$(npdoc "$1")
  [ -n "$d" ] || fail "missing NetworkPolicy $1"
  has "$d" "- Ingress" "$1"
  lacks "$d" "- Egress" "$1"
  has "$d" "$2" "$1"
  has "$d" "$3" "$1"
}
ingress_policy web-ingress "app.kubernetes.io/name: web" "port: 8080"
ingress_policy control-plane-ingress "app.kubernetes.io/name: control-plane" "port: 3000"
ingress_policy agent-ingress "app.kubernetes.io/name: agent" "port: 3100"
ingress_policy gateway-ingress "app.kubernetes.io/name: gateway" "port: 8080"
ingress_policy fx-mcp-ingress "app.kubernetes.io/name: fx-mcp" "port: 8080"
ingress_policy postgres-ingress "app.kubernetes.io/name: postgres" "port: 5432"
for n in web-ingress control-plane-ingress agent-ingress gateway-ingress; do
  d=$(npdoc "$n")
  has "$d" "$traefik" "$n"
  has "$d" "app.kubernetes.io/name: traefik" "$n"
done
has "$(npdoc control-plane-ingress)" "port: 3001" control-plane-ingress
has "$(npdoc control-plane-ingress)" "app.kubernetes.io/name: agent" control-plane-ingress
has "$(npdoc gateway-ingress)" "app.kubernetes.io/name: agent" gateway-ingress
has "$(npdoc fx-mcp-ingress)" "app.kubernetes.io/name: gateway" fx-mcp-ingress
d=$(npdoc postgres-ingress)
has "$d" "app.kubernetes.io/name: control-plane" postgres-ingress
has "$d" "app.kubernetes.io/name: gateway" postgres-ingress
lacks "$d" "app.kubernetes.io/name: agent" postgres-ingress
lacks "$d" "app.kubernetes.io/name: web" postgres-ingress
pass "platform ingress policies"

d=$(npdoc gateway-egress)
for want in "- Egress" "app.kubernetes.io/name: postgres" "port: 5432" "app.kubernetes.io/name: fx-mcp" "port: 8080" \
  "urumi.io/managed: \"true\"" "app.kubernetes.io/name: woo-mcp" "kubernetes.io/metadata.name: mcp-hosted" \
  "cidr: 0.0.0.0/0" "port: 443"; do
  has "$d" "$want" gateway-egress
done
lacks "$d" "- Ingress" gateway-egress
d=$(npdoc control-plane-egress)
for want in "- Egress" "app.kubernetes.io/name: postgres" "port: 5432" "cidr: 0.0.0.0/0" "port: 6443" "port: 443"; do
  has "$d" "$want" control-plane-egress
done
lacks "$d" "- Ingress" control-plane-egress
lacks "$d" "app.kubernetes.io/name: gateway" control-plane-egress
pass "platform egress policies"

# The public 443 rule must exclude the five private ranges, in every policy that opens it.
for n in gateway-egress agent-egress fx-mcp-egress; do
  d=$(npdoc "$n")
  for r in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    has "$d" "- $r" "$n public 443"
  done
done
# The control-plane may reach the API server on any address, so it has no except list.
lacks "$(npdoc control-plane-egress)" "except:" control-plane-egress
pass "public 443 rules exclude the private ranges"

# cert-manager HTTP-01 solver pods are created in the Ingress namespace and need Traefik to reach them.
lacks "$netpols" "http01-solver" "solver rule without tls"
tls=$(render --set ingress.tls.enabled=true --set ingress.tls.clusterIssuer=x | awk 'BEGIN{RS="---\n"} /kind: NetworkPolicy/')
has "$tls" "acme.cert-manager.io/http01-solver" "solver rule with tls"
has "$tls" "port: 8089" "solver rule with tls"
pass "solver rule follows ingress.tls.enabled"

# Every workload file: one probe pair per Deployment or StatefulSet, and the pod and container hardening.
for f in postgres control-plane gateway fx-mcp web agent; do
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

for f in control-plane gateway fx-mcp agent; do
  y=$(show "$f.yaml")
  per=$(count "$y" 'allowPrivilegeEscalation: false')
  [ "$(count "$y" 'readOnlyRootFilesystem: true')" -eq "$per" ] || fail "$f: readOnlyRootFilesystem on every container"
  [ "$(count "$y" 'runAsUser: 10001')" -eq 1 ] || fail "$f: runAsUser"
  has "$y" "mountPath: /tmp" "$f"
  has "$y" "emptyDir: {}" "$f"
done
[ "$(count "$cp" 'allowPrivilegeEscalation: false')" -eq 2 ] || fail "control-plane: migrate and main containers"
pass "node containers read-only with /tmp"

w=$(show web.yaml)
for want in "image: web:dev" "name: web" "containerPort: 8080" "port: 8080" "targetPort: http" \
  "runAsUser: 101" "runAsGroup: 101" "readOnlyRootFilesystem: true" "mountPath: /tmp" "emptyDir: {}" \
  "automountServiceAccountToken: false" "cpu: 20m" "memory: 32Mi" "cpu: 200m" "memory: 128Mi" \
  "app.kubernetes.io/component: web"; do
  has "$w" "$want" web
done
[ "$(probe_port "$w" readinessProbe)" = "8080" ] || fail "web readiness port"
[ "$(probe_port "$w" livenessProbe)" = "8080" ] || fail "web liveness port"
# The probes use flow style (httpGet: { path: /, port: 8080 }), which helm template keeps as written.
[ "$(count "$w" 'path: /, port: 8080')" -eq 2 ] || fail "web: probes must GET / on 8080"
lacks "$w" "secretKeyRef" web
pass "web"

a=$(show agent.yaml)
for want in "image: agent:dev" "name: agent" "containerPort: 3100" "port: 3100" "targetPort: http" \
  "automountServiceAccountToken: false" "terminationGracePeriodSeconds: 10" \
  "cpu: 50m" "memory: 128Mi" "cpu: 500m" "memory: 256Mi" "app.kubernetes.io/component: agent" \
  'value: "http://app.127.0.0.1.nip.io"' \
  'value: "http://control-plane-internal.platform.svc.cluster.local:3001"' \
  'value: "http://gateway.platform.svc.cluster.local:8080/mcp"' \
  'value: "https://generativelanguage.googleapis.com/v1beta/openai/"' 'value: "gemini-3.5-flash-lite"' \
  'value: "https://api.groq.com/openai/v1"' 'value: "openai/gpt-oss-120b"' 'value: "low"' \
  "name: agent-llm, key: LLM_API_KEY" "name: agent-llm, key: LLM_FALLBACK_API_KEY, optional: true" \
  "name: platform-crypto, key: INTERNAL_SECRET"; do
  has "$a" "$want" agent
done
[ "$(count "$a" 'path: /readyz, port: 3100')" -eq 1 ] || fail "agent: readiness on 3100"
[ "$(count "$a" 'path: /healthz, port: 3100')" -eq 1 ] || fail "agent: liveness on 3100"
# SPEC 13: no database and no upstream credentials.
for word in JWT_SIGNING_KEY DATABASE_URL API_KEY_PEPPER "key: KEK" platform-db serviceAccountName; do
  lacks "$a" "$word" agent
done
nf=$(show agent.yaml --set agent.llm.fallbackBaseUrl= --set agent.llm.reasoningEffort=)
lacks "$nf" "LLM_FALLBACK" agent-without-fallback
lacks "$nf" "LLM_REASONING_EFFORT" agent-without-fallback
pass "agent"

ig=$(show ingress-app.yaml)
for want in "ingressClassName: traefik" "host: app.127.0.0.1.nip.io" "path: /api" "name: control-plane" "number: 3000" "name: web" "number: 8080" "path: /api/chat" "name: agent" "number: 3100"; do
  has "$ig" "$want" ingress
done
[ "$(count "$ig" 'path: /$')" -eq 1 ] || fail "ingress: one / rule for web"
lacks "$ig" "tls:" ingress
pass "ingress"
im=$(show ingress-mcp.yaml)
for want in "ingressClassName: traefik" "host: mcp.127.0.0.1.nip.io" "path: /mcp" "name: gateway" "number: 8080"; do
  has "$im" "$want" ingress-mcp
done
lacks "$im" "tls:" ingress-mcp
lacks "$im" "9090" ingress-mcp
has "$(show ingress-mcp.yaml --set ingress.tls.enabled=true --set ingress.tls.clusterIssuer=le)" "secretName: mcp-tls" "ingress-mcp tls"
pass "ingress mcp"

all_notes=$(helm install platform charts/platform -n platform -f deploy/values-local.yaml --set mcp.sharedToken=test-token --dry-run=client 2>&1 || true)
has "$all_notes" "http://app.127.0.0.1.nip.io" notes
has "$all_notes" "admin@example.com" notes
has "$all_notes" "kubectl -n platform get secret platform-bootstrap -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d" notes
pass "notes"

{ render --set global.imageTag=latest 2>&1 || true; } | grep -q "global.imageTag must not be latest" || fail "imageTag latest accepted"
pass "imageTag latest rejected"

for f in fx-mcp.yaml gateway.yaml control-plane.yaml; do
  has "$(show "$f")" "terminationGracePeriodSeconds: 10" "$f"
done
pass "node services terminate within 10 s"

echo "OK"
