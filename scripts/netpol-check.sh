#!/usr/bin/env bash
# SPEC 16 proofs for store namespaces, with throwaway curl pods.
#   scripts/netpol-check.sh <slug-a> [<slug-b>]
#   scripts/netpol-check.sh platform
#   scripts/netpol-check.sh hosted <slug>
# Each probe sleeps 5 s first: kube-router admits a new pod's IP late, so the first request of a
# brand new pod is refused even where a policy allows it.
set -euo pipefail
cd "$(dirname "$0")/.."

A=${1:?usage: $0 <slug-a> [<slug-b>] | platform | hosted <slug>}
B=${2:-}
IMAGE=curlimages/curl:8.17.0
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

# probe NS LABELS URL: prints "<http code> exit=<curl exit>". Exit 28 is a timeout, 7 a refusal.
# The pod passes PodSecurity restricted. The image's user is a name (curl_user), which runAsNonRoot
# cannot verify, so the uid is set. --overrides replaces the containers list, so it carries the
# whole container, including small limits: the store quota caps limits.cpu and the LimitRange
# default would give each probe 500m.
probe() {
  local pod=probe-$$-$RANDOM labels=() script overrides
  [ "$2" = - ] || labels=(--labels "$2")
  script="sleep 5; c=\$(curl -m 5 -s -o /dev/null -w '%{http_code}' '$3'); echo \"\$c exit=\$?\""
  overrides=$(jq -cn --arg name "$pod" --arg image "$IMAGE" --arg script "$script" '{spec: {
    securityContext: {runAsNonRoot: true, runAsUser: 100, runAsGroup: 101, seccompProfile: {type: "RuntimeDefault"}},
    containers: [{name: $name, image: $image, command: ["sh", "-c", $script],
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}},
      resources: {requests: {cpu: "10m", memory: "16Mi"}, limits: {cpu: "100m", memory: "64Mi"}}}]}}')
  kubectl -n "$1" run "$pod" --restart=Never --image="$IMAGE" "${labels[@]}" --overrides="$overrides" >/dev/null
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

if [ "$A" = platform ]; then
  # A probe takes the labels of the workload it stands in for, so it gets that workload's policies.
  L=app.kubernetes.io/instance=platform,app.kubernetes.io/name
  pg=http://postgres.platform.svc.cluster.local:5432/
  gw=http://gateway.platform.svc.cluster.local:8080/healthz
  fx=http://fx-mcp.platform.svc.cluster.local:8080/healthz
  cp=http://control-plane-internal.platform.svc.cluster.local:3001/readyz
  gwpod=$(kubectl -n platform get pod -l app.kubernetes.io/name=gateway -o jsonpath='{.items[0].status.podIP}')
  [ -n "$gwpod" ] || fail "no gateway pod IP"

  for who in agent web fx-mcp; do
    r=$(probe platform "$L=$who" "$pg")
    blocked "$r" || fail "a $who-labeled pod reached postgres: $r"
  done
  r=$(probe platform "$L=control-plane" "$pg")
  opened "$r" || fail "a control-plane-labeled pod cannot reach postgres: $r"
  r=$(probe platform "$L=gateway" "$pg")
  opened "$r" || fail "a gateway-labeled pod cannot reach postgres: $r"
  pass "postgres: open to control-plane and gateway, closed to agent, web and fx-mcp"

  for target in "$gw" "$cp" "$fx"; do
    r=$(probe default - "$target")
    blocked "$r" || fail "the default namespace reached $target: $r"
  done
  r=$(probe platform - "$gw")
  blocked "$r" || fail "an unlabeled platform pod reached the gateway: $r"
  pass "gateway, control-plane internal port and fx-mcp: closed to the default namespace and to unlabeled pods"

  r=$(probe platform - https://example.com)
  blocked "$r" || fail "an unlabeled platform pod reached https://example.com: $r"
  r=$(probe platform "$L=fx-mcp" "$pg")
  blocked "$r" || fail "an fx-mcp-labeled pod reached postgres: $r"
  pass "unlabeled pods have no egress except DNS"

  r=$(probe platform "$L=gateway" "$fx")
  opened "$r" || fail "a gateway-labeled pod cannot reach fx-mcp: $r"
  r=$(probe platform "$L=gateway" "http://woo-mcp.store-main.svc.cluster.local:8080/healthz")
  opened "$r" || fail "a gateway-labeled pod cannot reach woo-mcp in store-main: $r"
  pass "gateway reaches fx-mcp and the store woo-mcp"

  r=$(probe platform "$L=agent" "$gw")
  opened "$r" || fail "an agent-labeled pod cannot reach the gateway on 8080: $r"
  r=$(probe platform "$L=agent" "http://$gwpod:9090/healthz")
  blocked "$r" || fail "an agent-labeled pod reached the gateway health port 9090: $r"
  r=$(probe platform "$L=agent" "$cp")
  opened "$r" || fail "an agent-labeled pod cannot reach the control-plane on 3001: $r"
  r=$(probe platform "$L=web" "$cp")
  blocked "$r" || fail "a web-labeled pod reached the control-plane on 3001: $r"
  pass "agent reaches gateway 8080 and control-plane 3001 only"
  echo OK
  exit 0
fi

if [ "$A" = hosted ]; then
  # SPEC 16 and 21: a hosted pod takes traffic from the gateway only and reaches DNS and public 443 only.
  # The pod needs a running hosted server, so create one first (scripts/hosted-check.sh create <slug>).
  slug=${B:?usage: $0 hosted <slug>}
  H=urumi.io/hosted=$slug
  url=http://$slug.mcp-hosted.svc.cluster.local:8080/healthz
  pg=http://postgres.platform.svc.cluster.local:5432/
  woo=http://woo-mcp.store-main.svc.cluster.local:8080/healthz
  # Any HTTP answer proves a connection: 000 means no connection, whatever the curl exit code.
  reached() { [ "${1%% *}" != 000 ]; }

  r=$(probe default - "$url")
  blocked "$r" || fail "the default namespace reached $slug: $r"
  r=$(probe mcp-hosted - "$url")
  blocked "$r" || fail "an unlabeled mcp-hosted pod reached $slug: $r"
  r=$(probe platform app.kubernetes.io/instance=platform,app.kubernetes.io/name=agent "$url")
  blocked "$r" || fail "an agent-labeled platform pod reached $slug: $r"
  r=$(probe platform app.kubernetes.io/instance=platform,app.kubernetes.io/name=gateway "$url")
  [ "${r%% *}" = 200 ] || fail "a gateway-labeled pod got '$r' from $slug /healthz, expected 200"
  pass "$slug takes traffic from the gateway's labels only (200 from the gateway, closed to default, mcp-hosted and agent)"

  for target in "$pg" "$woo"; do
    r=$(probe mcp-hosted "$H" "$target")
    blocked "$r" || fail "a pod labeled $H reached $target: $r"
  done
  # Port 80 on a public host: egress is TCP 443 only.
  r=$(probe mcp-hosted "$H" http://example.com)
  blocked "$r" || fail "a pod labeled $H reached http://example.com on port 80: $r"
  pass "$slug cannot reach Postgres, a store's woo-mcp or a public host on port 80"

  # The control proves the allow comes from the slug's own policy: the same URL fails without the label.
  r=$(probe mcp-hosted - https://api.frankfurter.app)
  blocked "$r" || fail "an unlabeled mcp-hosted pod reached https://api.frankfurter.app: $r"
  r=$(probe mcp-hosted "$H" https://api.frankfurter.app)
  reached "$r" || fail "a pod labeled $H cannot reach https://api.frankfurter.app: $r"
  pass "$slug reaches public 443 (api.frankfurter.app answered ${r%% *}); an unlabeled mcp-hosted pod does not"
  echo OK
  exit 0
fi

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

# Default deny leaves a store no way out: no public address, no other pod in the namespace.
for labels in app.kubernetes.io/name=woo-mcp,app.kubernetes.io/component=woo-mcp app.kubernetes.io/component=wordpress; do
  r=$(probe "store-$A" "$labels" https://example.com)
  blocked "$r" || fail "a store-$A pod labeled $labels reached https://example.com: $r"
done
r=$(probe "store-$A" app.kubernetes.io/name=woo-mcp,app.kubernetes.io/component=woo-mcp "$db")
blocked "$r" || fail "a store-$A pod labeled woo-mcp reached MariaDB: $r"
r=$(probe "store-$A" - "$wp")
blocked "$r" || fail "an unlabeled store-$A pod reached WordPress: $r"
r=$(probe "store-$A" app.kubernetes.io/component=cron "$db")
opened "$r" || fail "a store-$A pod labeled cron cannot reach MariaDB: $r"
for target in "$wp" https://example.com; do
  r=$(probe "store-$A" app.kubernetes.io/component=cron "$target")
  blocked "$r" || fail "a store-$A pod labeled cron reached $target: $r"
done
pass "store-$A wp-cron pod: MariaDB only"
pass "store-$A egress: no public address for woo-mcp and WordPress, no MariaDB for woo-mcp, nothing for unlabeled pods"

if [ -n "$B" ]; then
  r=$(probe "store-$B" app.kubernetes.io/name=woo-mcp "$wp")
  blocked "$r" || fail "a store-$B pod labeled like woo-mcp reached store-$A WordPress: $r"
  r=$(probe "store-$B" app.kubernetes.io/component=wordpress "$db")
  blocked "$r" || fail "a store-$B pod labeled like WordPress reached store-$A MariaDB: $r"
  pass "store-$B pods labeled like woo-mcp and WordPress cannot reach store-$A"
fi
echo OK
