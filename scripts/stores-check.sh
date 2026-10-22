#!/usr/bin/env bash
# Live checks for the store provisioner against the running cluster.
#   S=<dir> scripts/stores-check.sh create <slug> "<name>"
#   S=<dir> scripts/stores-check.sh delete <slug>
#   S=<dir> scripts/stores-check.sh all
# Needs kubectl, curl, jq and pnpm. Keys and cookies go to files under $S (mode 600), never stdout.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
# The store hosts follow APP: https://app.<domain> gives https://<slug>.shop.<domain>.
SCHEME=${APP%%://*}
DOMAIN=${DOMAIN:-${APP#*://app.}}
umask 077
mkdir -p "$S"
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

now() { date +%s; }

key_id=''
cleanup() {
  if [ -n "$key_id" ]; then req admin.jar DELETE "/api/keys/$key_id" >/dev/null || true; fi
  rm -f "$S/sc" "$S/sc.hdr"
}
trap cleanup EXIT

key_setup() {
  local r
  r=$(req admin.jar POST /api/keys '{"name":"stores-check"}')
  [ "$(code "$r")" = 201 ] || fail "create key gave $(code "$r")"
  key_id=$(body "$r" | jq -r .key.id)
  save_key "$(body "$r")" sc
}
tools() { pnpm -s tsx scripts/mcp-smoke.ts "$MCP" "$(cat "$S/sc")" "$@"; }

# post_store NAME KEY: POST /api/stores with an Idempotency-Key. The body, then the status code.
post_store() {
  curl -s -b "$S/admin.jar" -c "$S/admin.jar" -H "origin: $APP" -H 'content-type: application/json' \
    -H "idempotency-key: $2" --data-binary "$(jq -nc --arg n "$1" '{name: $n}')" \
    -w '\n%{http_code}' "$APP/api/stores"
}

# store_json SLUG: the store from GET /api/stores, empty when not listed. Fails while the API is down.
store_json() {
  local r
  r=$(req admin.jar GET /api/stores)
  [ "$(code "$r")" = 200 ] || return 1
  body "$r" | jq -c --arg s "$1" '.stores[] | select(.slug == $s)'
}

# wait_ready SLUG: prints each new state and step, sets elapsed. Polls through a control-plane restart.
wait_ready() {
  local t0 s st step last=''
  t0=$(now)
  while :; do
    [ $(($(now) - t0)) -lt 960 ] || fail "$1 not ready after 16 min"
    if ! s=$(store_json "$1"); then
      sleep 5
      continue
    fi
    [ -n "$s" ] || fail "$1 is not listed"
    st=$(jq -r .status <<<"$s")
    step=$(jq -r '.lastStep // "-"' <<<"$s")
    if [ "$st/$step" != "$last" ]; then
      echo "  $(($(now) - t0)) s: $st, step $step"
      last="$st/$step"
    fi
    case $st in
      ready)
        elapsed=$(($(now) - t0))
        return 0
        ;;
      failed) fail "$1 failed: $(jq -r .statusReason <<<"$s")" ;;
    esac
    sleep 5
  done
}

# store_mem SLUG: working set per pod from metrics-server, which lags about a minute.
store_mem() {
  local out=''
  for _ in $(seq 1 24); do
    out=$(kubectl top pods -n "store-$1" --no-headers 2>/dev/null || true)
    [ "$(grep -c . <<<"$out" || true)" -ge 3 ] && break
    sleep 5
  done
  awk -v s="$1" '{m=$3; sub(/Mi$/, "", m); t+=m; printf "  %s %s\n", $1, $3}
    END {printf "MEM: store-%s %d Mi in %d pods\n", s, t, NR}' <<<"$out"
}

cp_peak() {
  local b
  if b=$(kubectl -n platform exec deploy/control-plane -c control-plane -- cat /sys/fs/cgroup/memory.peak 2>/dev/null); then
    echo "MEM: control-plane container peak $((b / 1048576)) Mi of a 384 Mi limit"
  else
    echo "MEM: control-plane peak unknown (no memory.peak)"
  fi
}

phase_adopted() {
  local s
  s=$(store_json main)
  [ "$(jq -r .status <<<"$s")" = ready ] && [ "$(jq -r .deletable <<<"$s")" = false ] ||
    fail "main is not adopted as a ready, non-deletable store: $s"
  pass "store-main is adopted: ready and not deletable"
}

phase_create() { # SLUG NAME
  local r r2 id
  r=$(post_store "$2" "stores-check-$1")
  [ "$(code "$r")" = 202 ] || fail "create $1 gave $(code "$r"): $(body "$r")"
  id=$(body "$r" | jq -r .store.id)
  [ "$(body "$r" | jq -r .store.slug)" = "$1" ] || fail "slug of $2 is $(body "$r" | jq -r .store.slug)"
  r2=$(post_store "$2" "stores-check-$1")
  [ "$(code "$r2")" = 200 ] && [ "$(body "$r2" | jq -r .store.id)" = "$id" ] ||
    fail "the same Idempotency-Key gave $(code "$r2")"
  pass "create $1: 202, and the same Idempotency-Key gives 200 with the same store"
}

phase_ready() { # SLUG NAME
  local t0 out
  wait_ready "$1"
  pass "$1 ready $elapsed s after polling started"
  [ "$(kubectl get ns "store-$1" -o jsonpath='{.metadata.labels.urumi\.io/managed}')" = true ] ||
    fail "namespace store-$1 lacks urumi.io/managed=true"
  [ "$(curl -s "$SCHEME://$1.shop.$DOMAIN/wp-json/" | jq -r .name)" = "$2" ] || fail "storefront name of $1"
  pass "store-$1 is labeled and its storefront answers with \"$2\""
  t0=$(now)
  until out=$(tools "${1}__get_info" '{}' 2>/dev/null) && grep -qF "$2" <<<"$out"; do
    [ $(($(now) - t0)) -lt 60 ] || fail "${1}__get_info did not name the store within 60 s"
    sleep 2
  done
  pass "${1}__get_info answers through the gateway $(($(now) - t0)) s after ready"
  store_mem "$1"
}

phase_guards() {
  local id r
  id=$(store_json main | jq -r .id)
  r=$(req admin.jar DELETE "/api/stores/$id")
  [ "$(code "$r")" = 409 ] && [ "$(body "$r" | jq -r .error)" = seeded_store ] ||
    fail "deleting main gave $(code "$r")"
  pass "main cannot be deleted through the API (409 seeded_store)"
}

phase_delete() { # SLUG
  local id r t0 left out
  id=$(store_json "$1" | jq -r .id)
  [ -n "$id" ] || fail "$1 is not listed"
  r=$(req admin.jar DELETE "/api/stores/$id")
  [ "$(code "$r")" = 202 ] && [ "$(body "$r" | jq -r .store.status)" = deleting ] ||
    fail "delete $1 gave $(code "$r")"
  [ "$(code "$(req admin.jar DELETE "/api/stores/$id")")" = 202 ] || fail "a second delete of $1 must answer 202"
  pass "delete $1: 202 deleting, and 202 again"
  t0=$(now)
  # A failing tools/list must not pass as "no tools", so its output is captured first.
  until out=$(tools) && [ "$(grep -c "^${1}__" <<<"$out" || true)" = 0 ]; do
    [ $(($(now) - t0)) -lt 10 ] || fail "$1 tools still listed 10 s after the delete"
    sleep 1
  done
  pass "$1 tools are gone from tools/list after $(($(now) - t0)) s"
  while [ -n "$(store_json "$1")" ]; do
    [ $(($(now) - t0)) -lt 420 ] ||
      fail "$1 still listed after 7 min: $(store_json "$1" | jq -r '.lastStep + ": " + (.statusReason // "")')"
    sleep 5
  done
  pass "$1 row removed $(($(now) - t0)) s after the delete"
  # local-path removes a released volume shortly after its claim goes.
  until left=$(kubectl get ns,pvc,pv -A --no-headers 2>/dev/null | grep -c -- "$1" || true); [ "$left" = 0 ]; do
    [ $(($(now) - t0)) -lt 480 ] || fail "objects left for $1: $(kubectl get ns,pvc,pv -A --no-headers | grep -- "$1")"
    sleep 5
  done
  pass "kubectl get ns,pvc,pv -A | grep $1 prints nothing"
  [ "$(body "$(req admin.jar GET /api/servers)" | jq --arg s "$1" '[.servers[] | select(.slug == $s)] | length')" = 0 ] ||
    fail "server row for $1 is left"
  pass "$1 server row is gone"
}

rel_status() {
  kubectl -n "store-$1" get secret -l "owner=helm,name=store-$1" \
    -o jsonpath='{.items[-1:].metadata.labels.status}' 2>/dev/null || true
}

# main_snapshot: helm revision and pod identity of store-main, to prove the kill leaves it alone.
main_snapshot() {
  {
    kubectl -n store-main get secret -l owner=helm,name=store-main --no-headers -o custom-columns='N:.metadata.name,S:.metadata.labels.status'
    # wp-cron pods come and go every minute, so they are not part of the identity.
    kubectl -n store-main get pods -l 'app.kubernetes.io/component!=cron' --no-headers -o custom-columns='P:.metadata.name,U:.metadata.uid,R:.status.containerStatuses[*].restartCount'
  } | sort
}

# phase_kill SLUG...: once every release is pending-install, delete the control-plane pod.
phase_kill() {
  local s t0 old st b
  t0=$(now)
  for s in "$@"; do
    until [ "$(rel_status "$s")" = pending-install ]; do
      [ $(($(now) - t0)) -lt 180 ] || fail "store-$s never reached pending-install"
      sleep 2
    done
  done
  # helm now creates resources and waits for them: the window the provisioning demo kills in.
  sleep 20
  for s in "$@"; do
    st=$(rel_status "$s")
    [ "$st" = pending-install ] || fail "store-$s is $st before the kill: too fast to interrupt, rerun"
  done
  old=$(kubectl -n platform get pod -l app.kubernetes.io/name=control-plane -o name)
  if b=$(kubectl -n platform exec "$old" -c control-plane -- cat /sys/fs/cgroup/memory.peak 2>/dev/null); then
    echo "MEM: old control-plane peak while $* installed $((b / 1048576)) Mi of a 384 Mi limit"
  fi
  kill_at=$(now)
  kubectl -n platform delete $old --wait=false >/dev/null
  pass "deleted $old while $* were pending-install"
}

# phase_releases SLUG...: one release per store, none pending, and the new pod holds the lock.
phase_releases() {
  local out s n bad
  out=$(kubectl get secret -A -l owner=helm --no-headers \
    -o custom-columns='NS:.metadata.namespace,R:.metadata.labels.name,V:.metadata.labels.version,S:.metadata.labels.status')
  bad=$(awk '$4 ~ /pending|uninstalling/' <<<"$out")
  [ -z "$bad" ] || fail "stuck helm releases: $bad"
  for s in "$@"; do
    n=$(awk -v r="store-$s" '$2 == r' <<<"$out" | wc -l)
    [ "$(awk -v r="store-$s" '$2 == r && $4 == "deployed"' <<<"$out" | wc -l)" = 1 ] ||
      fail "store-$s has no single deployed release: $(awk -v r="store-$s" '$2 == r' <<<"$out" | tr '\n' ';')"
    [ "$(kubectl get ns -o name | grep -c "namespace/store-$s$")" = 1 ] || fail "namespace of store-$s"
    echo "  store-$s: $n helm secret(s), one deployed"
  done
  [ "$(awk '$2 ~ /^store-/ && $4 == "deployed"' <<<"$out" | awk '{print $2}' | sort | uniq -d | wc -l)" = 0 ] ||
    fail "duplicate deployed releases"
  pass "no duplicate helm releases and none pending-install, pending-upgrade or uninstalling"
}

phase_lock() {
  local pod n
  pod=$(kubectl -n platform get pod -l app.kubernetes.io/name=control-plane -o name)
  n=$(kubectl -n platform logs "$pod" -c control-plane | grep -c 'store provisioner elected' || true)
  [ "$n" = 1 ] || fail "$pod logged $n provisioner elections"
  pass "the new pod ${pod#pod/} took the provisioner lock (1 election)"
}

phase_recovered() { # SLUG NAME
  local reason
  phase_ready "$1" "$2"
  reason=$(store_json "$1" | jq -r .statusReason)
  [ "$reason" = "Recovered from pending-install left by an earlier run" ] || fail "$1 statusReason: $reason"
  pass "$1 recovered from the killed install"
}

phase_limit() {
  local r n
  n=$(body "$(req admin.jar GET /api/stores)" | jq --arg me "$admin_id" '[.stores[] | select(.owner.id == $me)] | length')
  [ "$n" = 3 ] || fail "the limit check needs the admin at 3 stores, found $n"
  r=$(post_store "Check Three" "stores-check-check-three")
  [ "$(code "$r")" = 409 ] && [ "$(body "$r" | jq -r .error)" = store_limit ] ||
    fail "a fourth store gave $(code "$r")"
  if kubectl get ns store-check-three >/dev/null 2>&1; then fail "a refused store got a namespace"; fi
  pass "a fourth store for the admin is refused with store_limit and nothing is created"
}

admin_login admin.jar
key_setup
admin_id=$(body "$(req admin.jar GET /api/me)" | jq -r .user.id)
case ${1:-} in
  create)
    [ $# -eq 3 ] || fail "usage: create <slug> <name>"
    phase_adopted
    phase_create "$2" "$3"
    phase_ready "$2" "$3"
    ;;
  delete)
    [ $# -eq 2 ] || fail "usage: delete <slug>"
    phase_guards
    phase_delete "$2"
    ;;
  all)
    phase_adopted
    main_before=$(main_snapshot)
    t_all=$(now)
    phase_create check-one "Check One"
    phase_create check-two "Check Two"
    phase_kill check-one check-two
    phase_recovered check-one "Check One"
    phase_recovered check-two "Check Two"
    echo "TIME: both stores ready $(($(now) - kill_at)) s after the kill, $(($(now) - t_all)) s after create"
    phase_lock
    phase_releases check-one check-two
    [ "$(main_snapshot)" = "$main_before" ] || fail "store-main changed during the run"
    pass "store-main is untouched: same helm revision, same pods, same restart counts"
    cp_peak
    scripts/netpol-check.sh check-one check-two
    phase_limit
    phase_guards
    phase_delete check-one
    phase_delete check-two
    ;;
  *)
    echo "usage: S=<dir> $0 create <slug> <name> | delete <slug> | all" >&2
    exit 2
    ;;
esac
cp_peak
echo OK
