#!/usr/bin/env bash
# SPEC 16 proofs for store namespaces, with throwaway curl pods.
#   scripts/netpol-check.sh <slug-a> [<slug-b>]
# Each probe sleeps 5 s first: kube-router admits a new pod's IP late, so the first request of a
# brand new pod is refused even where a policy allows it.
set -euo pipefail
cd "$(dirname "$0")/.."

A=${1:?usage: $0 <slug-a> [<slug-b>]}
B=${2:-}
IMAGE=curlimages/curl:8.17.0
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

# probe NS LABELS URL: prints "<http code> exit=<curl exit>". Exit 28 is a timeout, 7 a refusal.
probe() {
  local pod=probe-$$-$RANDOM labels=()
  [ "$2" = - ] || labels=(--labels "$2")
  kubectl -n "$1" run "$pod" --restart=Never --image="$IMAGE" "${labels[@]}" --command -- \
    sh -c "sleep 5; c=\$(curl -m 5 -s -o /dev/null -w '%{http_code}' '$3'); echo \"\$c exit=\$?\"" >/dev/null
  kubectl -n "$1" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$pod" --timeout=90s >/dev/null ||
    fail "probe pod $1/$pod did not finish"
  kubectl -n "$1" logs "$pod"
  kubectl -n "$1" delete pod "$pod" --wait=false >/dev/null
}
# SPEC 16 expects a timeout. A refusal also means no connection, so both count as blocked; the
# positive controls prove each target listens.
blocked() { [ "$1" = "000 exit=28" ] || [ "$1" = "000 exit=7" ]; }
# Any answer proves the connection opened, even curl rejecting MariaDB's binary greeting.
opened() {
  case ${1#* } in
    exit=28 | exit=7) return 1 ;;
  esac
}

wp=http://wordpress.store-$A.svc.cluster.local/
db=http://mariadb.store-$A.svc.cluster.local:3306/
mcp=http://woo-mcp.store-$A.svc.cluster.local:8080/healthz

r=$(probe "store-$A" app.kubernetes.io/name=woo-mcp "$wp")
opened "$r" || fail "store-$A woo-mcp cannot reach its own WordPress: $r"
r=$(probe default - "$wp")
blocked "$r" || fail "the default namespace reached store-$A WordPress: $r"
pass "store-$A WordPress: open to its woo-mcp, closed to the default namespace"

r=$(probe "store-$A" app.kubernetes.io/component=wordpress "$db")
opened "$r" || fail "store-$A WordPress cannot reach its own MariaDB: $r"
r=$(probe default - "$db")
blocked "$r" || fail "the default namespace reached store-$A MariaDB: $r"
pass "store-$A MariaDB: open to its WordPress, closed to the default namespace"

r=$(probe default - "$mcp")
blocked "$r" || fail "the default namespace reached store-$A woo-mcp: $r"
pass "store-$A woo-mcp: closed to the default namespace"

if [ -n "$B" ]; then
  r=$(probe "store-$B" app.kubernetes.io/name=woo-mcp "$wp")
  blocked "$r" || fail "a store-$B pod labeled like woo-mcp reached store-$A WordPress: $r"
  r=$(probe "store-$B" app.kubernetes.io/component=wordpress "$db")
  blocked "$r" || fail "a store-$B pod labeled like WordPress reached store-$A MariaDB: $r"
  pass "store-$B pods labeled like woo-mcp and WordPress cannot reach store-$A"
fi
echo OK
