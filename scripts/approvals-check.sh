#!/usr/bin/env bash
# Live check of tool pinning: one gh tool is made to look edited since its approval, it must leave
# the admin's tools/list within 3 s and show on /api/approvals, and approving the hash on screen
# brings it back. With --stop-before-approve it stops after the first half so the dashboard can
# be checked by hand.
# Needs kubectl, curl, jq and pnpm, and the server `gh` connected. Secrets go to files under $S
# (mode 600) and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
SLUG=${SLUG:-gh}
stop_early=0
[ "${1:-}" = --stop-before-approve ] && stop_early=1
umask 077
mkdir -p "$S"
run=approvals-$(date +%s)
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

psql_one() {
  kubectl -n platform exec postgres-0 -- psql -U platform -d platform -At -c "$1"
}
listed() { pnpm -s tsx scripts/mcp-smoke.ts "$MCP" "$(cat "$S/approvals-key")" 2>/dev/null | cut -f1; }
# until_listed WANT: wait up to 3 s for the tool to be present (1) or absent (0).
until_listed() {
  local t0
  t0=$(date +%s%N)
  while :; do
    if grep -qx "$exposed" <<<"$(listed)"; then [ "$1" = 1 ] && return 0; else [ "$1" = 0 ] && return 0; fi
    [ "$(ms_since "$t0")" -lt 3000 ] || return 1
    sleep 0.3
  done
}

admin_login admin.jar
r=$(req admin.jar POST /api/keys "{\"name\":\"$run\"}")
[ "$(code "$r")" = 201 ] || fail "create key"
key_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" approvals-key
cleanup() { req admin.jar DELETE "/api/keys/$key_id" >/dev/null || true; }
trap cleanup EXIT

server_id=$(psql_one "select id from mcp_servers where slug = '$SLUG'")
[ -n "$server_id" ] || fail "no server $SLUG"
name=$(psql_one "select t.name from mcp_tools t where t.server_id = '$server_id' and t.state = 'active' order by t.name limit 1")
[ -n "$name" ] || fail "$SLUG has no active tool (is it connected?)"
exposed="${SLUG}__${name}"
until_listed 1 || fail "$exposed is not listed before the test"
pass "$exposed is listed before the edit"

psql_one "update mcp_tools set approved_hash = 'edited-since-approval', state = 'changed' where server_id = '$server_id' and name = '$name'" >/dev/null
psql_one "select pg_notify('registry_changed', '$server_id')" >/dev/null
until_listed 0 || fail "$exposed still listed 3 s after the edit"
pass "$exposed left the admin tool list within 3 s"

r=$(req admin.jar GET /api/approvals)
[ "$(code "$r")" = 200 ] || fail "GET /api/approvals gave $(code "$r")"
shown=$(body "$r" | jq -r --arg s "$SLUG" --arg n "$name" \
  '.servers[] | select(.slug == $s) | .tools[] | select(.name == $n) | .definitionHash')
[ -n "$shown" ] || fail "/api/approvals does not show $exposed"
pass "/api/approvals shows $exposed with its hash"

if [ "$stop_early" = 1 ]; then
  echo "Stopped before approving. Open $APP/approvals, check $exposed, press Approve."
  trap - EXIT
  cleanup
  exit 0
fi

stale=$(req admin.jar POST "/api/servers/$server_id/approve" "{\"tools\":{\"$name\":\"$(printf '0%.0s' {1..64})\"}}")
[ "$(code "$stale")" = 200 ] || fail "approve with a wrong hash gave $(code "$stale")"
[ "$(body "$stale" | jq -r '.stale | index("'"$name"'") != null')" = true ] || fail "a wrong hash was not reported as stale"
until_listed 0 || fail "$exposed came back after approving a hash nobody saw"
pass "a hash the admin did not see approves nothing"

r=$(req admin.jar POST "/api/servers/$server_id/approve" "{\"tools\":{\"$name\":\"$shown\"}}")
[ "$(code "$r")" = 200 ] || fail "approve gave $(code "$r")"
[ "$(body "$r" | jq -r '.approved | index("'"$name"'") != null')" = true ] || fail "$name was not approved"
until_listed 1 || fail "$exposed did not come back within 3 s"
state=$(psql_one "select state from mcp_tools where server_id = '$server_id' and name = '$name'")
[ "$state" = active ] || fail "state is $state"
pass "approving the hash on screen brings $exposed back"
echo OK
