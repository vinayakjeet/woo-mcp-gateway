#!/usr/bin/env bash
# Scaling demo: 20 tool calls through the Ingress at 0.5 s intervals, spread over the gateway replicas,
# with one gateway pod deleted after call 8. Every call must answer 200 without a tool error.
# Needs 2 or more gateway replicas: make platform HELM_FLAGS="--wait --set gateway.replicas=2".
# Prints no passwords, cookies, tokens or keys.
# Usage: S=<private scratch dir> scripts/replica-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
CALLS=${CALLS:-20}
DELETE_AFTER=${DELETE_AFTER:-8}
umask 077
mkdir -p "$S"
run=replica-$(date +%s)
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

key_id=""
cleanup() {
  if [ -n "$key_id" ]; then req admin.jar DELETE "/api/keys/$key_id" >/dev/null 2>&1 || true; fi
  rm -f "$S/replica-key" "$S/replica-key.hdr" "$S/replica-headers" "$S/replica-body"
}
trap cleanup EXIT

want=$(kubectl -n platform get deploy gateway -o jsonpath='{.spec.replicas}')
want=${want:-1}
[ "$want" -ge 2 ] || fail "the gateway Deployment has $want replica(s); set gateway.replicas to 2 or more first"
ready() { kubectl -n platform get deploy gateway -o jsonpath='{.status.readyReplicas}'; }
for _ in $(seq 1 60); do
  [ "$(ready)" = "$want" ] && break
  sleep 2
done
[ "$(ready)" = "$want" ] || fail "only $(ready) of $want gateway pods are ready"
pass "$want gateway pods ready"

admin_login admin.jar
r=$(req admin.jar POST /api/keys "{\"name\":\"$run\"}")
[ "$(code "$r")" = 201 ] || fail "create key"
key_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" replica-key

call_body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"main__get_info","arguments":{}}}'
declare -a names=() failures=()
deleted=""
before_delete=()
for i in $(seq 1 "$CALLS"); do
  status=$(curl -s -o "$S/replica-body" -D "$S/replica-headers" --max-time 20 -w '%{http_code}' -X POST "$MCP" \
    -H @"$S/replica-key.hdr" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' \
    --data-binary "$call_body" || true)
  replica=$(tr -d '\r' <"$S/replica-headers" 2>/dev/null | sed -n 's/^[Xx]-[Gg]ateway-[Rr]eplica: //p' | head -1 || true)
  payload=$(sed -n 's/^data: //p' "$S/replica-body" 2>/dev/null || true)
  [ -n "$payload" ] || payload=$(cat "$S/replica-body" 2>/dev/null || true)
  iserr=$(jq -r '.result.isError // false' <<<"$payload" 2>/dev/null || echo parse_error)
  names+=("${replica:--}")
  printf '%2d  %s  isError=%s  %s\n' "$i" "$status" "$iserr" "${replica:--}"
  if [ "$status" != 200 ] || [ "$iserr" != false ]; then
    failures+=("call $i: status $status isError=$iserr replica=${replica:--}")
  fi
  if [ "$i" -le "$DELETE_AFTER" ]; then before_delete+=("${replica:--}"); fi
  if [ "$i" -eq "$DELETE_AFTER" ]; then
    # The pod that just answered, so the delete hits a pod that is in use.
    deleted=${replica:-}
    [ -n "$deleted" ] && [ "$deleted" != - ] || fail "call $i named no replica, nothing to delete"
    kubectl -n platform delete pod "$deleted" --wait=false >/dev/null
    echo "--- deleted $deleted"
  fi
  sleep 0.5
done

echo "--- replicas that answered"
printf '%s\n' "${names[@]}" | sort | uniq -c
distinct_before=$(printf '%s\n' "${before_delete[@]}" | grep -v '^-$' | sort -u | wc -l)
ok=$((CALLS - ${#failures[@]}))
echo "$ok of $CALLS ok"
for f in "${failures[@]}"; do echo "FAILED $f" >&2; done
[ "${#failures[@]}" -eq 0 ] || fail "$((${#failures[@]})) call(s) failed while pod $deleted was deleted"
[ "$distinct_before" -ge 2 ] || fail "only $distinct_before replica name(s) answered before the delete"
pass "$distinct_before replica names answered before the delete, no call failed while $deleted was deleted"

for _ in $(seq 1 60); do
  [ "$(ready)" = "$want" ] && break
  sleep 2
done
[ "$(ready)" = "$want" ] || fail "the gateway did not return to $want ready pods"
pass "the Deployment is back to $want ready pods"
echo OK
