#!/usr/bin/env bash
# Live checks for hosted MCP servers (SPEC 21), through the dashboard API.
#   S=<scratchpad> scripts/hosted-check.sh create <slug> [NAME=VALUE ...]
#   S=<scratchpad> scripts/hosted-check.sh check|delete|offline <slug>
#   S=<scratchpad> scripts/hosted-check.sh all
# create applies the demo image (fx-mcp:dev) with optional plain env and waits for ready. check
# proves the tools, the pod security, the object count, the rejections and that no secret value
# leaks. delete proves the tools vanish at once and that nothing labeled for the slug stays. all
# runs the three on slug fx2. offline creates the server with an unroutable rates API, expects
# its tool calls to answer with fx_unreachable, and deletes it.
# A tool call passes when the gateway reached the server and the server answered (audit outcome
# ok or tool_error), so no check here needs the rates API. netpol-check.sh hosted proves egress.
# create and delete poll through a control-plane restart, so a restart in the middle is harmless.
# Needs kubectl, curl, jq and pnpm. Secrets go to files under $S (mode 600) and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
NS=mcp-hosted
umask 077
mkdir -p "$S"
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

tools() { pnpm -s tsx scripts/mcp-smoke.ts "$MCP" "$(cat "$S/$1")" "${@:2}"; }
# A GET that survives a control-plane restart: any failure prints nothing.
hosted_list() { body "$(req hosted.jar GET /api/hosted)" 2>/dev/null || true; }
row() { # slug, jq filter on that slug's row
  hosted_list | jq -r --arg s "$1" ".servers[]? | select(.slug == \$s) | $2" 2>/dev/null || true
}
labeled() { kubectl -n "$NS" get all,secret,netpol -l "urumi.io/hosted=$1" -o name 2>/dev/null || true; }
# One login per run: the control-plane allows 5 logins per email per minute, and all followed by
# offline would otherwise make 6.
logged_in=
login() {
  [ -z "$logged_in" ] || return 0
  admin_login hosted.jar
  logged_in=1
}

KEY_IDS=()
trap revoke_keys EXIT
with_key() { # makes $S/hosted-key and $S/hosted-key.hdr, revoked on exit
  local r
  r=$(req hosted.jar POST /api/keys "{\"name\":\"hosted-check-$(date +%s)\"}")
  [ "$(code "$r")" = 201 ] || fail "create key"
  KEY_IDS+=("$(body "$r" | jq -r .key.id)")
  save_key "$(body "$r")" hosted-key
}
revoke_keys() {
  local id
  for id in "${KEY_IDS[@]}"; do req hosted.jar DELETE "/api/keys/$id" >/dev/null 2>&1 || true; done
  rm -f "$S/hosted-key" "$S/hosted-key.hdr"
}

create() { # slug [NAME=VALUE ...] as plain env
  local slug=$1 r t0 state
  shift
  login
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$S/hosted-demo-secret"
  jq -n --arg slug "$slug" --rawfile secret "$S/hosted-demo-secret" '{
    slug: $slug, image: "fx-mcp:dev", port: 8080, path: "/mcp", cpu: "200m", memory: "128Mi",
    env: ($ARGS.positional | map(capture("^(?<name>[^=]+)=(?<value>.*)$"))),
    secretEnv: [{name: "DEMO_SECRET", value: $secret}]}' --args "$@" >"$S/hosted-create.json"
  r=$(curl -s -b "$S/hosted.jar" -H "origin: $APP" -H 'content-type: application/json' \
    --data-binary @"$S/hosted-create.json" -w '\n%{http_code}' "$APP/api/hosted")
  rm -f "$S/hosted-create.json"
  [ "$(code "$r")" = 201 ] || fail "create $slug gave $(code "$r"): $(body "$r" | jq -c '{error, issues}' 2>/dev/null)"
  t0=$(date +%s)
  until [ "$(row "$slug" .status)" = ready ]; do
    state=$(row "$slug" .status)
    [ "$state" != failed ] || fail "$slug failed: $(row "$slug" .reason)"
    [ $(($(date +%s) - t0)) -lt 120 ] || fail "$slug not ready after 120 s (status ${state:-none}, reason $(row "$slug" .reason))"
    sleep 1
  done
  pass "$slug ready in $(($(date +%s) - t0)) s"
}

# answered SLUG EXPOSED OUTPUT SINCE [WANT]: passes when the newest audit row for EXPOSED since
# SINCE says the server answered (ok or tool_error). WANT=tool_error:<text> instead requires a tool
# error whose output contains <text>. OUTPUT is what mcp-smoke printed for the call.
answered() {
  local slug=$1 exposed=$2 out=$3 since=$4 want=${5:-} outcome
  outcome=$(body "$(req hosted.jar GET "/api/audit?server=$slug&from=$since")" |
    jq -r --arg e "$exposed" '[.items[]? | select(.exposedName == $e)][0].outcome // "none"')
  case $want:$outcome in
    :ok) pass "$exposed answered ok" ;;
    :tool_error | tool_error:*:tool_error)
      if [ -n "$want" ] && ! grep -qF "${want#tool_error:}" <<<"$out"; then
        fail "$exposed answered with a tool error without '${want#tool_error:}': $(head -c 60 <<<"$out")"
      fi
      pass "$exposed answered with a tool error ($(head -n1 <<<"$out" | head -c 60))"
      ;;
    *) fail "$exposed: audit outcome '$outcome' (want ${want:-ok or tool_error}); gateway status $(body "$(req hosted.jar GET /api/servers)" | jq -c --arg s "$slug" '.servers[] | select(.slug == $s) | .status | {state, errorKind}')" ;;
  esac
}

check() { # slug [WANT for the tool calls, see answered]
  local slug=$1 want=${2:-} r names n t0 count uid ro since out
  login
  [ -s "$S/hosted-demo-secret" ] || fail "no $S/hosted-demo-secret: run create first"
  with_key

  # The gateway health check runs every 15 s, so allow it a minute to see the new server.
  t0=$(date +%s)
  until [ "$(body "$(req hosted.jar GET /api/servers)" | jq -r --arg s "$slug" '.servers[] | select(.slug == $s) | "\(.status.state) \(.status.toolCount)"')" = "connected 3" ]; do
    [ $(($(date +%s) - t0)) -lt 60 ] || fail "$slug is not connected with 3 tools in the gateway status"
    sleep 1
  done
  pass "gateway status: $slug connected, 3 tools"

  names=$(tools hosted-key) || fail "tools/list"
  for t in get_info convert_currency get_rates; do
    grep -q "^${slug}__$t[[:space:]]" <<<"$names" || fail "${slug}__$t is not listed"
  done
  pass "tools/list shows ${slug}__get_info, ${slug}__convert_currency and ${slug}__get_rates"

  # mcp-smoke exits 1 on a tool error too; the audit row decides (see answered).
  since=$(date -u -d '-2 sec' +%Y-%m-%dT%H:%M:%SZ)
  out=$(tools hosted-key "${slug}__get_info" 2>&1) || true
  answered "$slug" "${slug}__get_info" "$out" "$since" "$want"
  out=$(tools hosted-key "${slug}__convert_currency" '{"amount":100,"from":"USD","to":"INR"}' 2>&1) || true
  answered "$slug" "${slug}__convert_currency" "$out" "$since" "$want"
  pass "the gateway reached $slug for both calls (public 443 egress is proven by netpol-check.sh hosted)"

  [ "$(kubectl -n "$NS" get deploy,svc,netpol,secret -l "urumi.io/hosted=$slug" -o name | wc -l)" -eq 4 ] ||
    fail "expected 4 objects labeled $slug"
  pass "4 objects carry urumi.io/hosted=$slug"

  uid=$(kubectl -n "$NS" get pod -l "urumi.io/hosted=$slug" -o jsonpath='{.items[0].spec.securityContext.runAsUser}')
  ro=$(kubectl -n "$NS" get pod -l "urumi.io/hosted=$slug" -o jsonpath='{.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem}')
  [ "$uid" = 10001 ] && [ "$ro" = true ] || fail "pod runs as uid '$uid' with readOnlyRootFilesystem '$ro'"
  pass "pod runs as uid 10001 with a read-only root"

  # The generated gateway token must stay as secret as the one the admin typed.
  kubectl -n "$NS" get secret "$slug-env" -o jsonpath='{.data.MCP_SHARED_TOKEN}' | base64 -d >"$S/hosted-token"
  [ -s "$S/hosted-token" ] || fail "no MCP_SHARED_TOKEN in $slug-env"
  for f in hosted-demo-secret hosted-token; do
    count=$(hosted_list | grep -cF -f "$S/$f" || true)
    [ "$count" = 0 ] || fail "$f appears in GET /api/hosted"
    count=$(kubectl -n platform logs deploy/control-plane --since=1h 2>/dev/null | grep -cF -f "$S/$f" || true)
    [ "$count" = 0 ] || fail "$f appears in the control-plane log"
  done
  rm -f "$S/hosted-token"
  pass "the demo secret and the generated token appear in neither GET /api/hosted nor the control-plane log"

  post() { # JAR JSON; the status code
    code "$(req "$1" POST /api/hosted "$2")"
  }
  base='"slug":"hostedchk","port":8080,"cpu":"200m","memory":"128Mi"'
  [ "$(post hosted.jar "{$base,\"image\":\"busybox:1.37\"}")" = 400 ] || fail "busybox:1.37 was not refused"
  [ "$(post hosted.jar "{$base,\"image\":\"fx-mcp:latest\"}")" = 400 ] || fail "fx-mcp:latest was not refused"
  [ "$(post hosted.jar "{\"slug\":\"hostedchk\",\"port\":8080,\"cpu\":\"600m\",\"memory\":\"128Mi\",\"image\":\"fx-mcp:dev\"}")" = 400 ] ||
    fail "cpu 600m was not refused"
  [ "$(post hosted.jar '{"slug":"fx","port":8080,"cpu":"200m","memory":"128Mi","image":"fx-mcp:dev"}')" = 409 ] ||
    fail "slug fx (a seeded server) was not refused with 409"
  pass "busybox:1.37, fx-mcp:latest and cpu 600m answer 400; slug fx answers 409"

  # asha is the demo member (demo-reset.sh keeps her password in .notes/demo/asha.pw).
  [ -s .notes/demo/asha.pw ] || fail "no .notes/demo/asha.pw: run demo-reset.sh --reset-member-password"
  jq -n --rawfile pw .notes/demo/asha.pw '{email: "asha@example.com", password: ($pw | rtrimstr("\n"))}' >"$S/member-login.json"
  r=$(curl -s -c "$S/hosted-member.jar" -H "origin: $APP" -H 'content-type: application/json' \
    --data-binary @"$S/member-login.json" -w '\n%{http_code}' "$APP/api/auth/login")
  rm -f "$S/member-login.json"
  [ "$(code "$r")" = 200 ] || fail "member login gave $(code "$r")"
  [ "$(post hosted-member.jar "{$base,\"image\":\"fx-mcp:dev\"}")" = 403 ] || fail "a member could POST /api/hosted"
  [ "$(code "$(req hosted-member.jar GET /api/hosted)")" = 403 ] || fail "a member could GET /api/hosted"
  rm -f "$S/hosted-member.jar"
  pass "a member gets 403 on GET and POST /api/hosted"
}

delete() {
  local slug=$1 id t0 before after names
  login
  with_key
  id=$(row "$slug" .id)
  [ -n "$id" ] || fail "no hosted server $slug"
  before=$(body "$(req hosted.jar GET "/api/audit?server=$slug")" | jq '.items | length')
  [ "$(code "$(req hosted.jar DELETE "/api/hosted/$id")")" = 202 ] || fail "DELETE gave something other than 202"
  t0=$(date +%s%N)
  while :; do
    names=$(tools hosted-key) || fail "tools/list failed during the delete"
    grep -q "^${slug}__" <<<"$names" || break
    [ "$(ms_since "$t0")" -lt 3000 ] || fail "${slug}__ tools still listed 3 s after the DELETE"
    sleep 0.2
  done
  pass "${slug}__ tools gone from the list $(ms_since "$t0") ms after the DELETE"

  t0=$(date +%s)
  until [ -z "$(labeled "$slug")" ] && [ -z "$(row "$slug" .id)" ]; do
    [ $(($(date +%s) - t0)) -lt 120 ] || fail "$slug not gone after 120 s: $(labeled "$slug" | tr '\n' ' ')$(row "$slug" '.status + " " + (.reason // "")')"
    sleep 1
  done
  pass "nothing labeled urumi.io/hosted=$slug is left and the hosted row is gone ($(($(date +%s) - t0)) s)"

  after=$(body "$(req hosted.jar GET "/api/audit?server=$slug")" | jq '.items | length')
  [ "$after" -ge "$before" ] || fail "audit rows for $slug dropped from $before to $after"
  pass "audit rows for $slug remain ($after)"
}

case ${1:-} in
  create) create "${2:?slug}" "${@:3}" ;;
  check) check "${2:?slug}" ;;
  delete) delete "${2:?slug}" ;;
  all)
    create fx2
    check fx2
    delete fx2
    ;;
  offline)
    # TEST-NET-1 is never routed: the fetch hits fx-mcp's 10 s timeout inside the gateway's 15 s.
    create "${2:?slug}" FX_BASE_URL=https://192.0.2.1/v1
    check "$2" tool_error:fx_unreachable
    delete "$2"
    ;;
  *)
    echo "usage: $0 create <slug> [NAME=VALUE ...] | check|delete|offline <slug> | all" >&2
    exit 2
    ;;
esac
echo OK
