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
    -f deploy/store-values-local.yaml --set slug=main --set-string storeName="Main Store" --set mcp.sharedToken=test-token "$@"
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

w=$(show wordpress.yaml)
pod_checks "$w" 33 wordpress
for want in "kind: PersistentVolumeClaim" "name: wordpress-html" "type: Recreate" \
  "image: store-wordpress:dev" "fsGroup: 33" "containerPort: 8080" "port: 80" "targetPort: http" \
  "path: /healthz.php" "tcpSocket:" "periodSeconds: 20" "failureThreshold: 6" \
  "failureThreshold: 30" "cpu: 100m" "memory: 256Mi" "memory: 512Mi" \
  "key: MARIADB_PASSWORD" "key: WORDPRESS_NONCE_SALT" "define('WP_HOME', 'http://main.shop.127.0.0.1.nip.io');" \
  "define('WP_ENVIRONMENT_TYPE', 'local');" "mountPath: /var/www/html"; do
  has "$w" "$want" wordpress
done
lacks "$w" "sysctls:" wordpress
pass "wordpress"

# The MariaDB PVC and the Secrets outlive an uninstall, so the WordPress files must too.
# Otherwise a reinstall pairs an installed database with empty uploads.
pvc=$(awk 'BEGIN{RS="---\n"} /kind: PersistentVolumeClaim/' <<<"$w")
has "$pvc" "helm.sh/resource-policy: keep" "wordpress-html PVC"
pass "wordpress-html PVC kept on uninstall"

# The volume root is root-owned and setgid (local-path plus fsGroup), so the official
# entrypoint's tar copy fails there. WordPress lives in a uid 33 subdirectory instead.
for want in "initContainers:" "name: prepare-html" "- mkdir" "- /volume/html" "mountPath: /volume" "subPath: html"; do
  has "$w" "$want" "wordpress subPath"
done
[ "$(grep -c "runAsUser: 33" <<<"$w")" -ge 1 ] || fail "wordpress subPath: uid"
[ "$(grep -c "cpu: 10m" <<<"$w")" -eq 1 ] || fail "wordpress subPath: init resources"
pass "wordpress subPath html"

i=$(show ingress.yaml)
for want in "ingressClassName: traefik" "host: main.shop.127.0.0.1.nip.io" "name: wordpress"; do
  has "$i" "$want" ingress
done
lacks "$i" "tls:" ingress
it=$(show ingress.yaml --set ingress.tls.enabled=true --set ingress.tls.clusterIssuer=letsencrypt-prod)
has "$it" "cert-manager.io/cluster-issuer: letsencrypt-prod" "ingress tls"
has "$it" "secretName: wordpress-tls" "ingress tls"
pass "ingress"

{ render --set global.imageTag=latest 2>&1 || true; } | grep -q "global.imageTag must not be latest" || fail "imageTag latest accepted"
pass "imageTag latest rejected"

j=$(show bootstrap-job.yaml)
pod_checks "$j" 33 bootstrap
for want in "kind: Job" "name: store-bootstrap" "\"helm.sh/hook\": post-install,post-upgrade" \
  "\"helm.sh/hook-delete-policy\": before-hook-creation,hook-succeeded" \
  "backoffLimit: 3" "activeDeadlineSeconds: 600" "restartPolicy: Never" \
  "- /opt/store/bootstrap.sh" "name: STORE_NAME" "value: \"Main Store\"" \
  "key: WP_ADMIN_PASSWORD" "key: WC_CONSUMER_KEY" "key: WC_CONSUMER_SECRET" \
  "claimName: wordpress-html" "cpu: 500m" "memory: 384Mi"; do
  has "$j" "$want" bootstrap
done
has "$j" "subPath: html" bootstrap
lacks "$j" "readinessProbe" bootstrap
pass "bootstrap job"

render | grep -q "main.shop.127.0.0.1.nip.io" || fail "render"
helm template store-main charts/store -n store-main -f deploy/store-values-local.yaml --set slug=main --set mcp.sharedToken=test-token >/dev/null
pass "full render"

w=$(show woo-mcp.yaml)
has "$w" "kind: Deployment" woo-mcp
has "$w" "app.kubernetes.io/name: woo-mcp" woo-mcp
lacks "$w" "app.kubernetes.io/name: store" woo-mcp
# Every Service selects on a component label, so no Service can route to another workload's pods.
for svc in wordpress.yaml mariadb.yaml woo-mcp.yaml; do
  sel=$(show "$svc" | awk '/^kind: Service$/{svc=1} svc&&/^  selector:/{p=1;next} p&&/^  [a-z]/{p=0;svc=0} p')
  services=$(show "$svc" | grep -c '^kind: Service$')
  [ "$(grep -c 'app.kubernetes.io/component:' <<<"$sel")" -eq "$services" ] || fail "$svc: a Service selector lacks app.kubernetes.io/component"
done
has "$(show woo-mcp.yaml)" "app.kubernetes.io/component: woo-mcp" woo-mcp
pass "service selectors include component"
has "$w" "image: woo-mcp:dev" woo-mcp
for s in "runAsNonRoot: true" "runAsUser: 10001" "type: RuntimeDefault" "allowPrivilegeEscalation: false" "readOnlyRootFilesystem: true" "automountServiceAccountToken: false" "path: /readyz" "path: /healthz" "cpu: 20m" "memory: 64Mi" "cpu: 250m" "memory: 192Mi"; do
  has "$w" "$s" woo-mcp
done
has "$w" "value: http://wordpress.store-main.svc.cluster.local" woo-mcp
has "$w" 'value: "http://main.shop.127.0.0.1.nip.io"' woo-mcp
has "$w" "name: store-wc-api" woo-mcp
has "$w" "name: store-mcp-token" woo-mcp
lacks "$w" "test-token" woo-mcp
pass "woo-mcp deployment"

n=$(show networkpolicy-woo-mcp.yaml)
has "$n" "kind: NetworkPolicy" netpol
has "$n" "policyTypes:" netpol
has "$n" "kubernetes.io/metadata.name: platform" netpol
has "$n" "app.kubernetes.io/name: gateway" netpol
# The control-plane makes the provisioner's one get_info call before it marks a store ready.
has "$n" "app.kubernetes.io/name: control-plane" netpol
[ "$(grep -c 'kubernetes.io/metadata.name: platform' <<<"$n")" -eq 2 ] || fail "netpol: gateway and control-plane peers"
[ "$(grep -c 'port: ' <<<"$n")" -eq 1 ] || fail "netpol: only port 8080"
has "$n" "port: 8080" netpol
pass "woo-mcp networkpolicy"

if helm template x charts/store -f deploy/store-values-local.yaml --set slug=main >/dev/null 2>&1; then
  fail "render without mcp.sharedToken must fail"
fi
pass "sharedToken required"
has "$(show woo-mcp.yaml)" "terminationGracePeriodSeconds: 10" woo-mcp
pass "woo-mcp terminates within 10 s"

# The bootstrap Job writes STORE_NAME into blogname on every install and upgrade, so the name
# survives a reinstall only if every installer path feeds it the right value.
# WSL exports NAME as the machine name, so only NAME on the make command line may rename a store.
n=$(NAME=SOME-HOSTNAME make -s -n store SLUG=main)
has "$n" 'storeName="Main Store"' "make store"
n=$(make -s -n store SLUG=main NAME="Shop Two")
has "$n" 'storeName="Shop Two"' "make store"
pass "make store takes NAME only from the command line"
d=$(helm template store-main charts/store --namespace store-main -f deploy/store-values-local.yaml \
  --set slug=main --set mcp.sharedToken=test-token --show-only templates/bootstrap-job.yaml)
has "$d" 'value: "Main Store"' "chart default storeName"
pass "a release installed without storeName still gives the bootstrap Main Store"

q=$(show guardrails.yaml)
for want in "kind: ResourceQuota" "name: store-quota" "requests.cpu: \"1\"" "requests.memory: 1536Mi" \
  "limits.cpu: \"3\"" "limits.memory: 2Gi" "persistentvolumeclaims: \"3\"" "requests.storage: 8Gi" \
  "pods: \"10\"" "kind: LimitRange" "name: store-limits" "type: Container"; do
  has "$q" "$want" guardrails
done
lr=$(awk 'BEGIN{RS="---\n"} /kind: LimitRange/' <<<"$q")
for want in "defaultRequest:" "cpu: 50m" "memory: 64Mi" "default:" "cpu: 500m" "memory: 256Mi" \
  "max:" "cpu: \"1\"" "memory: 1Gi"; do
  has "$lr" "$want" limitrange
done
has "$(show guardrails.yaml --set quota.requestsStorage=20Gi)" "requests.storage: 20Gi" "quota override"
pass "resource quota and limit range"

np=$(show networkpolicy-store.yaml)
wp=$(awk 'BEGIN{RS="---\n"} /name: wordpress-ingress/' <<<"$np")
for want in "app.kubernetes.io/component: wordpress" "policyTypes: [Ingress]" \
  "kubernetes.io/metadata.name: kube-system" "app.kubernetes.io/name: traefik" \
  "app.kubernetes.io/name: woo-mcp" "port: 8080"; do
  has "$wp" "$want" "wordpress policy"
done
db=$(awk 'BEGIN{RS="---\n"} /name: mariadb-ingress/' <<<"$np")
for want in "app.kubernetes.io/component: mariadb" "policyTypes: [Ingress]" \
  "values: [wordpress, bootstrap]" "port: 3306"; do
  has "$db" "$want" "mariadb policy"
done
# A peer without a namespaceSelector is this namespace only, which is what keeps stores apart.
[ "$(grep -c namespaceSelector <<<"$wp")" -eq 1 ] || fail "wordpress policy: only Traefik may come from another namespace"
[ "$(grep -c namespaceSelector <<<"$db")" -eq 0 ] || fail "mariadb policy: no other namespace may connect"
pass "store networkpolicies"

echo "OK"
