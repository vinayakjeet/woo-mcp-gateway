#!/usr/bin/env bash
# Live checks for the store provisioner (SPEC 18) against the running cluster.
#   S=<dir> scripts/stores-check.sh create <slug> "<name>"
# Needs kubectl, curl, jq and pnpm. Keys and cookies go to files under $S (mode 600), never stdout.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
DOMAIN=${DOMAIN:-127.0.0.1.nip.io}
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
  [ "$(curl -s "http://$1.shop.$DOMAIN/wp-json/" | jq -r .name)" = "$2" ] || fail "storefront name of $1"
  pass "store-$1 is labeled and its storefront answers with \"$2\""
  t0=$(now)
  until out=$(tools "${1}__get_info" '{}' 2>/dev/null) && grep -qF "$2" <<<"$out"; do
    [ $(($(now) - t0)) -lt 60 ] || fail "${1}__get_info did not name the store within 60 s"
    sleep 2
  done
  pass "${1}__get_info answers through the gateway $(($(now) - t0)) s after ready"
  store_mem "$1"
}

admin_login admin.jar
key_setup
case ${1:-} in
  create)
    [ $# -eq 3 ] || fail "usage: create <slug> <name>"
    phase_adopted
    phase_create "$2" "$3"
    phase_ready "$2" "$3"
    ;;
  *)
    echo "usage: S=<dir> $0 create <slug> <name>" >&2
    exit 2
    ;;
esac
cp_peak
echo OK
