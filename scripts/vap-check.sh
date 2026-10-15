#!/usr/bin/env bash
# SPEC 18 and 22.3 proofs for the control-plane admission policy.
#   S=<scratchpad> scripts/vap-check.sh
# The first rows impersonate the ServiceAccount with --as and --dry-run=server, so nothing is stored.
# Every denial must name the policy: RBAC already allows these verbs, so a refusal without the
# policy name would mean something else stopped the request. The last rows use a real token.
set -euo pipefail
cd "$(dirname "$0")/.."

S=${S:?set S to the scratchpad directory}
SA=system:serviceaccount:platform:control-plane
POLICY=control-plane-namespaces
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

as_sa() { kubectl --as="$SA" "$@" 2>&1 | grep -v 'version difference' || true; }

denied() { # output of a kubectl call, what it was
  grep -q "$POLICY" <<<"$1" && grep -q 'denied request' <<<"$1" || fail "$2: expected a denial by $POLICY, got: $1"
}
allowed() {
  if grep -q 'denied request\|Forbidden\|forbidden' <<<"$1"; then fail "$2: expected it to be allowed, got: $1"; fi
}

kubectl get validatingadmissionpolicy "$POLICY" >/dev/null || fail "policy $POLICY is not installed"
kubectl get validatingadmissionpolicybinding "$POLICY" >/dev/null || fail "binding $POLICY is not installed"

for ns in default platform kube-system; do
  r=$(as_sa create configmap vap-probe -n "$ns" --dry-run=server)
  denied "$r" "ConfigMap in $ns"
done
pass "ConfigMaps in default, platform and kube-system are denied"

for ns in store-main mcp-hosted; do
  r=$(as_sa create configmap vap-probe -n "$ns" --dry-run=server)
  allowed "$r" "ConfigMap in $ns"
  grep -q 'created (server dry run)' <<<"$r" || fail "ConfigMap in $ns: unexpected answer: $r"
done
pass "ConfigMaps in store-main and mcp-hosted are allowed"

# M11: hosted servers are applied server-side, which is a PATCH, not a create. Same policy, same verdict.
deploy_yaml() { # namespace
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata: { name: vap-probe, namespace: $1 }
spec:
  selector: { matchLabels: { app: vap-probe } }
  template:
    metadata: { labels: { app: vap-probe } }
    spec:
      containers: [{ name: c, image: 'fx-mcp:dev' }]
YAML
}
sa_apply() { deploy_yaml "$1" | as_sa apply --server-side --dry-run=server --field-manager=platform --force-conflicts -f -; }
r=$(sa_apply mcp-hosted)
allowed "$r" "server-side apply of a Deployment in mcp-hosted"
grep -q 'serverside-applied (server dry run)' <<<"$r" || fail "apply in mcp-hosted: unexpected answer: $r"
r=$(sa_apply default)
denied "$r" "server-side apply of a Deployment in default"
pass "server-side apply of a Deployment: allowed in mcp-hosted, denied in default"

r=$(as_sa create namespace m10-vap-probe --dry-run=server)
denied "$r" "Namespace m10-vap-probe"
r=$(as_sa create namespace store-vap-probe --dry-run=server)
allowed "$r" "Namespace store-vap-probe"
grep -q 'created (server dry run)' <<<"$r" || fail "Namespace store-vap-probe: unexpected answer: $r"
pass "a Namespace is judged by its own name"

# Delete reads oldObject. The admin creates the namespace, so the ServiceAccount only tries to delete it.
trap 'kubectl delete namespace m10-vap-probe store-vap-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
kubectl create namespace m10-vap-probe >/dev/null
r=$(as_sa delete namespace m10-vap-probe)
denied "$r" "delete of Namespace m10-vap-probe"
kubectl get namespace m10-vap-probe >/dev/null || fail "m10-vap-probe is gone after a denied delete"
kubectl delete namespace m10-vap-probe --wait=false >/dev/null
kubectl create namespace store-vap-probe >/dev/null
r=$(as_sa delete namespace store-vap-probe --dry-run=server)
allowed "$r" "delete of Namespace store-vap-probe"
grep -q 'deleted (server dry run)' <<<"$r" || fail "delete of Namespace store-vap-probe: unexpected answer: $r"
kubectl delete namespace store-vap-probe --wait=false >/dev/null
pass "deleting a Namespace is judged by oldObject: m10-vap-probe denied, store-vap-probe allowed"

# Other cluster-scoped kinds are not tested: RBAC refuses them (the role only grants namespaces) before
# admission runs, so the policy branch for them is a second wall that this ServiceAccount cannot reach.

# Reads are not matched by the policy.
r=$(as_sa get configmap kube-root-ca.crt -n default -o name)
allowed "$r" "read in default"
grep -q 'kube-root-ca.crt' <<<"$r" || fail "read in default: unexpected answer: $r"
pass "reads are not affected"

# SPEC 18's own test: a real token, no impersonation.
umask 077
kc="$S/vap-check.kubeconfig"
trap 'rm -f "$kc"; kubectl delete namespace m10-vap-probe store-vap-probe --ignore-not-found --wait=false >/dev/null 2>&1 || true; kubectl delete configmap vap-probe -n default --ignore-not-found >/dev/null 2>&1 || true' EXIT
token=$(kubectl create token control-plane -n platform --duration=10m 2>/dev/null)
kubectl config view --minify --raw -o json | jq --arg token "$token" '{
  apiVersion: "v1", kind: "Config",
  clusters: [{name: "c", cluster: {server: .clusters[0].cluster.server, "certificate-authority-data": .clusters[0].cluster["certificate-authority-data"]}}],
  users: [{name: "u", user: {token: $token}}],
  contexts: [{name: "x", context: {cluster: "c", user: "u"}}],
  "current-context": "x"}' >"$kc"
unset token
r=$(KUBECONFIG="$kc" kubectl create configmap vap-probe -n default 2>&1 | grep -v 'version difference' || true)
denied "$r" "ConfigMap in default with a real token"
r=$(KUBECONFIG="$kc" kubectl create configmap vap-probe -n store-main --dry-run=server 2>&1 | grep -v 'version difference' || true)
grep -q 'created (server dry run)' <<<"$r" || fail "ConfigMap in store-main with a real token: $r"
rm -f "$kc"
kubectl get configmap vap-probe -n default >/dev/null 2>&1 && fail "the ConfigMap exists in default"
pass "a real ServiceAccount token cannot create a ConfigMap in default"
echo OK
