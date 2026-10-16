#!/usr/bin/env bash
# Live checks against the cluster: login, keys, a revoked key rejected within 1 s, server disable
# and enable, the store name, a dead upstream (fx-mcp at zero), woo-mcp reachable only from the
# gateway, invites, audit attribution and member scoping, role policies (hidden tools, a deny rule
# added and removed), tool search mode, a per-key rate limit, disabling a member, and one agent turn.
# Needs kubectl, curl, jq and pnpm. Secrets go to files under $S (mode 600) and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
umask 077
mkdir -p "$S"
run=e2e-$(date +%s)
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

mcp_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$MCP" -H @"$S/$1.hdr" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
}
tools() { pnpm -s tsx scripts/mcp-smoke.ts "$MCP" "$(cat "$S/$1")" "${@:2}"; }
count_prefix() {
  local out
  out=$(tools "$1") || true
  grep -c "^${2}__" <<<"$out" || true
}
psql_one() { kubectl -n platform exec postgres-0 -- psql -U platform -d platform -At -c "$1"; }
# fx_answered KEY KEY_ID: calls fx__get_info and is true when the gateway reached fx-mcp and it
# answered (audit outcome ok or tool_error), so a rates API outage does not fail e2e.
fx_answered() {
  local outcome
  tools "$1" fx__get_info >/dev/null 2>&1 || true
  outcome=$(psql_one "select outcome from audit_events where api_key_id = '$2'
    and exposed_name = 'fx__get_info' order by ts desc, id desc limit 1")
  [ "$outcome" = ok ] || [ "$outcome" = tool_error ]
}

admin_login admin.jar
me=$(body "$(req admin.jar GET /api/me)")
[ "$(jq -r .user.role <<<"$me")" = admin ] || fail "/api/me"
admin_id=$(jq -r .user.id <<<"$me")
admin_email=$(jq -r .user.email <<<"$me")
# The attribution checks below look only at audit rows from this run.
since=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)
pass "admin login and /api/me"

nr=$(curl -s -o /dev/null -w '%{http_code}' -b "$S/admin.jar" -X POST -H 'content-type: application/json' \
  --data-binary '{"name":"x"}' "$APP/api/keys")
[ "$nr" = 403 ] || fail "POST /api/keys without Origin gave $nr"
pass "a state change without Origin is 403"

[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/")" = 200 ] || fail "web /"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/servers")" = 200 ] || fail "web SPA fallback"
[ "$(curl -s "$APP/api/config" | jq -r .gatewayUrl)" = "$MCP" ] || fail "/api/config"
pass "web serves the SPA and /api reaches the control-plane"

# Revoke: the key is used first so the gateway caches it; the 401 must follow within 1 s.
r=$(req admin.jar POST /api/keys "{\"name\":\"$run-revoke\"}")
[ "$(code "$r")" = 201 ] || fail "create key"
k1_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" k1
tools k1 >/dev/null || fail "fresh key cannot list tools"
[ "$(mcp_status k1)" != 401 ] || fail "fresh key rejected"
t0=$(date +%s%N)
[ "$(code "$(req admin.jar DELETE "/api/keys/$k1_id")")" = 204 ] || fail "revoke"
until [ "$(mcp_status k1)" = 401 ]; do
  [ "$(ms_since "$t0")" -lt 1000 ] || fail "revoked key still accepted after 1 s"
  sleep 0.05
done
pass "revoked key gets 401 $(ms_since "$t0") ms after the DELETE started"

# Disable fx: its tools leave tools/list; enabling brings them back.
r=$(req admin.jar POST /api/keys "{\"name\":\"$run-admin\"}")
k2_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" k2
fx_id=$(body "$(req admin.jar GET /api/servers)" | jq -r '.servers[] | select(.slug == "fx") | .id')
[ -n "$fx_id" ] || fail "no fx server"
[ "$(count_prefix k2 fx)" -ge 1 ] || fail "fx tools missing before disable"
# A listen stream (2026-07-28 clients only) is open while fx is disabled and must get the hint.
tools k2 --listen '{"seconds":12}' >"$S/listen.out" 2>&1 &
listen_pid=$!
t0=$(date +%s%N)
until grep -q '^READY' "$S/listen.out" 2>/dev/null; do
  [ "$(ms_since "$t0")" -lt 30000 ] || { kill "$listen_pid" 2>/dev/null || true; fail "the listen stream did not start: $(tail -n 2 "$S/listen.out")"; }
  sleep 0.2
done
t0=$(date +%s%N)
[ "$(code "$(req admin.jar PATCH "/api/servers/$fx_id" '{"enabled":false}')")" = 200 ] || fail "disable fx"
until grep -q '^list_changed' "$S/listen.out"; do
  [ "$(ms_since "$t0")" -lt 3000 ] || { kill "$listen_pid" 2>/dev/null || true; fail "no tools/list_changed on the listen stream 3 s after disabling fx"; }
  sleep 0.1
done
pass "a listen stream got tools/list_changed $(ms_since "$t0") ms after fx was disabled"
kill "$listen_pid" 2>/dev/null || true
until [ "$(count_prefix k2 fx)" -eq 0 ]; do
  [ "$(ms_since "$t0")" -lt 8000 ] || fail "fx tools still listed 5 s after disable"
done
pass "disabled fx: its tools are gone after $(ms_since "$t0") ms"
[ "$(code "$(req admin.jar PATCH "/api/servers/$fx_id" '{"enabled":true}')")" = 200 ] || fail "enable fx"
t0=$(date +%s%N)
until [ "$(count_prefix k2 fx)" -ge 1 ]; do
  [ "$(ms_since "$t0")" -lt 10000 ] || fail "fx tools not back 10 s after enable"
  sleep 0.5
done
pass "enabled fx: its tools are back"

r=$(tools k2 main__get_info) || fail "admin call main__get_info"
grep -q '"name": "Main Store"' <<<"$r" || fail "main__get_info does not say Main Store"
pass "main__get_info names Main Store"

# Dead upstream: fx-mcp at zero. Only fx calls fail, and fast; main keeps answering and the list
# stays under 1 s. The EXIT trap brings fx back even when a check fails or the run is stopped.
restore_fx() { kubectl -n platform scale deploy/fx-mcp --replicas=1 >/dev/null 2>&1 || true; }
trap 'exit 130' INT TERM
trap restore_fx EXIT
kubectl -n platform scale deploy/fx-mcp --replicas=0 >/dev/null
t0=$(date +%s%N)
until [ -z "$(kubectl -n platform get pods -l app.kubernetes.io/name=fx-mcp -o name)" ]; do
  [ "$(ms_since "$t0")" -lt 60000 ] || fail "fx-mcp pods still running 60 s after scaling to zero"
  sleep 0.5
done
r=$(rpc k2 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fx__get_info","arguments":{}}}')
t=$(tail -n1 <<<"$r")
[ "$(sed '$d' <<<"$r" | jq -r '.result.isError')" = true ] || fail "fx call did not fail with fx-mcp at zero"
under "$t" 2 || fail "fx call took $t s to fail"
pass "fx call fails in $t s with fx-mcp at zero"
r=$(rpc k2 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"main__get_info","arguments":{}}}')
[ "$(sed '$d' <<<"$r" | jq -r '.result.structuredContent.name // "none"')" = 'Main Store' ] ||
  fail "main call failed while fx is down"
pass "main keeps answering while fx is down"
t0=$(date +%s%N)
until [ "$(body "$(req admin.jar GET /api/servers)" | jq -r '.servers[] | select(.slug == "fx") | .status.state')" = unreachable ]; do
  [ "$(ms_since "$t0")" -lt 35000 ] || fail "fx not shown unreachable 35 s after it went down"
  sleep 0.5
done
r=$(rpc k2 '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}')
t=$(tail -n1 <<<"$r")
under "$t" 1 || fail "tools/list took $t s with fx down"
names=$(sed '$d' <<<"$r" | jq -r '.result.tools[].name') || fail "tools/list gave no result"
grep -q '^main__get_info$' <<<"$names" || fail "main tools missing from the list while fx is down"
! grep -q '^fx__' <<<"$names" || fail "fx tools still listed while fx is down"
pass "fx shown unreachable; tools/list took $t s with main tools and no fx tools"
restore_fx
kubectl -n platform rollout status deploy/fx-mcp --timeout=120s >/dev/null
t0=$(date +%s%N)
until fx_answered k2 "$k2_id"; do
  [ "$(ms_since "$t0")" -lt 60000 ] || fail "fx not answering 60 s after scaling back"
  sleep 1
done
trap - EXIT INT TERM
pass "fx answers again $(ms_since "$t0") ms after its pod was ready"

# SPEC 16: only the gateway reaches woo-mcp. The gateway connecting first proves the probe and the
# host name work, so "blocked" from the other pods means the NetworkPolicy, not a typo.
woo_probe_node() {
  kubectl -n platform exec "deploy/$1" -c "$1" -- node -e '
    const s = require("node:net").connect(8080, "woo-mcp.store-main.svc.cluster.local");
    s.setTimeout(3000, () => { console.log("blocked timeout"); process.exit(0); });
    s.on("connect", () => { console.log("open"); process.exit(0); });
    s.on("error", (e) => { console.log("blocked " + e.code); process.exit(0); });'
}
[ "$(woo_probe_node gateway)" = open ] || fail "the gateway cannot open a connection to woo-mcp"
p=$(woo_probe_node control-plane)
[[ $p == blocked* ]] || fail "control-plane reached woo-mcp ($p)"
p=$(kubectl -n store-main exec deploy/wordpress -c wordpress -- \
  php -r '$s = @fsockopen("woo-mcp", 8080, $n, $m, 3); echo $s ? "open" : "blocked";')
[ "$p" = blocked ] || fail "the WordPress pod reached woo-mcp ($p)"
pass "woo-mcp accepts the gateway and refuses control-plane and WordPress"

# WordPress cannot run wp-cron itself (its loopback goes to 127.0.0.1 inside the pod), so the
# wp-cron CronJob must have run in the last 3 minutes and nothing may be more than 5 minutes overdue.
last=$(kubectl -n store-main get cronjob wp-cron -o jsonpath='{.status.lastSuccessfulTime}')
[ -n "$last" ] || fail "the wp-cron CronJob has never succeeded"
age=$(($(date +%s) - $(date -d "$last" +%s)))
[ "$age" -lt 180 ] || fail "the wp-cron CronJob last succeeded ${age}s ago"
overdue=$(kubectl -n store-main exec deploy/wordpress -c wordpress -- wp --path=/var/www/html eval '
  global $wpdb;
  echo (int) $wpdb->get_var("select count(*) from {$wpdb->prefix}actionscheduler_actions
    where status = \"pending\" and scheduled_date_gmt < UTC_TIMESTAMP() - interval 5 minute")
  + count(array_filter(_get_cron_array(), fn($t) => $t < time() - 300, ARRAY_FILTER_USE_KEY));')
[ "$overdue" = 0 ] || fail "store-main has $overdue cron events or Action Scheduler actions overdue by more than 5 minutes"
pass "wp-cron ran ${age}s ago and nothing is overdue"

# Invite a member and accept once.
r=$(req admin.jar POST /api/invites "{\"email\":\"$run@example.com\",\"role\":\"member\"}")
[ "$(code "$r")" = 201 ] || fail "invite"
token=$(body "$r" | jq -r .url | sed 's|.*/invite/||')
head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$S/member.pw"
jq -n --rawfile pw "$S/member.pw" '{password: $pw}' >"$S/member-accept.json"
r=$(curl -s -c "$S/member.jar" -H "origin: $APP" -H 'content-type: application/json' \
  --data-binary @"$S/member-accept.json" -w '\n%{http_code}' "$APP/api/invites/$token/accept")
rm -f "$S/member-accept.json" "$S/member.pw"
[ "$(code "$r")" = 200 ] || fail "accept invite gave $(code "$r")"
member_id=$(body "$r" | jq -r .user.id)
[ "$(code "$(req member.jar POST "/api/invites/$token/accept" '{"password":"another-password-1"}')")" = 404 ] ||
  fail "invite accepted twice"
[ "$(code "$(req member.jar POST /api/servers '{}')")" = 403 ] || fail "member changed servers"
pass "invite accepted once; the member cannot change servers"

r=$(req member.jar POST /api/keys "{\"name\":\"$run-member\"}")
k3_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" k3
r=$(req member.jar POST /api/keys "{\"name\":\"$run-member-2\"}")
k4_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" k4
fx_answered k3 "$k3_id" || fail "member call fx__get_info"
fx_answered k2 "$k2_id" || fail "admin call fx__get_info"

t0=$(date +%s%N)
until body "$(req member.jar GET /api/audit)" |
  jq -e --arg e "$run@example.com" '(.items | length) > 0 and all(.items[]; .userEmail == $e)' >/dev/null; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "member audit rows"
  sleep 0.2
done
pass "the member sees only their own audit rows"
body "$(req member.jar GET "/api/audit?user=$admin_id")" |
  jq -e --arg e "$run@example.com" '(.items | length) > 0 and all(.items[]; .userEmail == $e)' >/dev/null ||
  fail "a member asking for the admin's rows saw someone else's"
pass "a member asking for the admin's rows still gets only their own"
body "$(req admin.jar GET "/api/audit?user=$member_id")" | jq -e '.items[0].exposedName == "fx__get_info"' >/dev/null ||
  fail "admin view of the member's rows"
body "$(req admin.jar GET '/api/audit?server=fx')" |
  jq -e --arg e "$run@example.com" '[.items[].userEmail] | (index($e) != null) and any(.[]; . != $e)' >/dev/null ||
  fail "admin sees every user's rows"
pass "the admin sees every user's rows and can filter by user"

# Narrow queries: one page holds 50 rows, and the fx reconnect loop above can add many fx rows.
rows=$(body "$(req admin.jar GET "/api/audit?user=$admin_id&server=main&from=$since")")
jq -e --arg a "$admin_email" '[.items[] | select(.userEmail == $a and .via == "api_key"
  and .exposedName == "main__get_info" and .outcome == "ok")] | length >= 2' <<<"$rows" >/dev/null ||
  fail "the admin's main calls are not audited to $admin_email via api_key"
rows=$(body "$(req admin.jar GET "/api/audit?user=$admin_id&server=fx&from=$since")")
jq -e --arg a "$admin_email" 'all(.items[]; .userEmail == $a and .via == "api_key")
  and any(.items[]; .outcome == "ok") and any(.items[]; .outcome != "ok")' <<<"$rows" >/dev/null ||
  fail "the admin's fx calls, ok and failed, are not audited to $admin_email via api_key"
rows=$(body "$(req admin.jar GET "/api/audit?user=$member_id&from=$since")")
jq -e --arg e "$run@example.com" '(.items | length) > 0 and all(.items[]; .userEmail == $e and .via == "api_key")' \
  <<<"$rows" >/dev/null || fail "the member's calls are not audited to the member via api_key"
pass "audit attributes each key call to its user, via api_key, failures included"

# SPEC 8: the seeded member rules hide write tools and answer a call to them like a missing tool.
# Output is captured first: grep -q can close the pipe early, and pipefail would call that a failure.
list_names() {
  local out
  out=$(tools "$1") || return 1
  cut -f1 <<<"$out"
}
has_tool() { grep -qx "$2" <<<"$(list_names "$1")"; }
member_names=$(list_names k3) || fail "member tools/list"
admin_names=$(list_names k2) || fail "admin tools/list"
grep -qx 'fx__get_info' <<<"$member_names" || fail "member list lacks fx__get_info"
grep -qx 'main__list_orders' <<<"$member_names" || fail "member list lacks main__list_orders"
! grep -qx 'main__create_product' <<<"$member_names" || fail "member list shows main__create_product"
grep -qx 'main__create_product' <<<"$admin_names" || fail "admin list lacks main__create_product"
[ -z "$(comm -23 <(sort <<<"$member_names") <(sort <<<"$admin_names"))" ] ||
  fail "the member sees a tool the admin does not"
pass "the member list hides main__create_product; the admin list keeps every tool"

denied=$(tools k3 main__create_product '{"name":"x"}' 2>&1) && fail "member called main__create_product"
grep -q 'Unknown tool: main__create_product' <<<"$denied" || fail "member call error was: $denied"
missing=$(tools k3 main__no_such_tool 2>&1) && fail "member called a missing tool"
[ "${denied//main__create_product/<n>}" = "${missing//main__no_such_tool/<n>}" ] ||
  fail "a hidden tool and a missing tool answer differently"
pass "a member call of a hidden tool fails like a missing tool"

policy_id=""
cleanup_policy() {
  [ -z "$policy_id" ] || req admin.jar DELETE "/api/policies/$policy_id" >/dev/null 2>&1 || true
}
trap cleanup_policy EXIT
r=$(req admin.jar POST /api/policies \
  '{"role":"member","serverPattern":"fx","toolPattern":"get_info","effect":"deny","priority":10}')
[ "$(code "$r")" = 201 ] || fail "create policy gave $(code "$r")"
policy_id=$(body "$r" | jq -r .policy.id)
t0=$(date +%s%N)
until ! has_tool k3 fx__get_info; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "fx__get_info still listed 3 s after a member deny rule"
  sleep 0.1
done
pass "a member deny rule hides fx__get_info after $(ms_since "$t0") ms"
has_tool k2 fx__get_info || fail "the member deny rule hid fx__get_info from the admin"
[ "$(code "$(req admin.jar DELETE "/api/policies/$policy_id")")" = 204 ] || fail "delete policy"
policy_id=""
t0=$(date +%s%N)
until has_tool k3 fx__get_info; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "fx__get_info not back 3 s after the rule was deleted"
  sleep 0.1
done
trap - EXIT
pass "deleting the rule brings fx__get_info back after $(ms_since "$t0") ms"

t0=$(date +%s%N)
until body "$(req member.jar GET '/api/audit?server=main&outcome=denied')" |
  jq -e '[.items[] | select(.exposedName == "main__create_product")] | length == 1' >/dev/null; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "the member's audit view lacks one denied row for main__create_product"
  sleep 0.2
done
pass "the member's audit view has one denied row for main__create_product"

# SPEC 17: tool search mode. ?toolMode=search lists only the two meta-tools, search_tools ranks the
# principal's visible tools, and call_tool goes through the same checks and audit as a direct call.
search_tools() { MCP="$MCP?toolMode=search" tools "$@"; }
search_names=$(MCP="$MCP?toolMode=search" list_names k2) || fail "search-mode tools/list"
[ "$search_names" = $'call_tool\nsearch_tools' ] || fail "search mode listed: $search_names"
pass "?toolMode=search lists exactly call_tool and search_tools"

# The first output line is the compact JSON text block of the result.
found=$(search_tools k2 search_tools '{"query":"convert currency"}' | head -n1)
[ "$(jq -r '.tools[0].name' <<<"$found")" = fx__convert_currency ] || fail "search ranked: $(jq -c '[.tools[].name]' <<<"$found")"
pass "search_tools 'convert currency' puts fx__convert_currency first"

# A tool error (rates API down) still proves call_tool reached fx-mcp; the audit row decides.
search_tools k2 call_tool '{"name":"fx__get_info"}' >/dev/null 2>&1 || true
t0=$(date +%s%N)
until [ "$(psql_one "select count(*) from audit_events where api_key_id = '$k2_id' and meta_tool = 'call_tool'
  and tool_name = 'get_info' and exposed_name = 'fx__get_info' and server_slug = 'fx'
  and outcome in ('ok', 'tool_error')")" -ge 1 ]; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "no audit row for get_info with meta_tool = call_tool"
  sleep 0.2
done
[ "$(psql_one "select count(*) from audit_events where api_key_id = '$k2_id' and meta_tool = 'search_tools'
  and server_slug = '' and outcome = 'ok'")" -ge 1 ] || fail "no audit row for search_tools"
pass "call_tool is audited as get_info with meta_tool = call_tool; search_tools has its own row"

found=$(search_tools k3 search_tools '{"query":"create product"}' | head -n1)
! jq -e 'any(.tools[]; .name == "main__create_product")' <<<"$found" >/dev/null ||
  fail "a member's search found main__create_product"
denied=$(search_tools k3 call_tool '{"name":"main__create_product","arguments":{"name":"x"}}' 2>&1) &&
  fail "a member ran main__create_product through call_tool"
grep -q 'Unknown tool: main__create_product' <<<"$denied" || fail "call_tool error was: $denied"
t0=$(date +%s%N)
until [ "$(psql_one "select count(*) from audit_events where user_id = '$member_id' and meta_tool = 'call_tool'
  and outcome = 'denied' and exposed_name = 'main__create_product'")" -ge 1 ]; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "no denied audit row with meta_tool for the member"
  sleep 0.2
done
pass "a member's search hides main__create_product and call_tool of it fails, audited denied"

bad=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MCP?toolMode=bogus" -H @"$S/k2.hdr" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[ "$bad" = 400 ] || fail "?toolMode=bogus gave $bad"
pass "?toolMode=bogus is 400"

# Decision A: a key created with toolMode search needs no override.
r=$(req admin.jar POST /api/keys "{\"name\":\"$run-search\",\"toolMode\":\"search\"}")
[ "$(code "$r")" = 201 ] || fail "create search key gave $(code "$r")"
k5_id=$(body "$r" | jq -r .key.id)
[ "$(body "$r" | jq -r .key.toolMode)" = search ] || fail "the new key is not in search mode"
save_key "$(body "$r")" k5
[ "$(list_names k5)" = $'call_tool\nsearch_tools' ] || fail "a search key listed: $(list_names k5)"
[ "$(MCP="$MCP?toolMode=full" list_names k5 | grep -c .)" -ge 10 ] || fail "?toolMode=full did not list the full set"
body "$(req admin.jar GET /api/keys)" | jq -e --arg id "$k5_id" 'any(.keys[]; .id == $id and .toolMode == "search")' >/dev/null ||
  fail "GET /api/keys lacks the key's toolMode"
pass "a key created in search mode lists two tools; ?toolMode=full lists them all"

# SPEC 19: a key limited to 3 calls a minute. All counted calls must share one window, so wait
# for the start of a minute when fewer than 15 seconds of this one are left.
while [ "$((10#$(date +%S)))" -ge 45 ]; do sleep 1; done
since_rl=$(date -u -d '-2 seconds' +%Y-%m-%dT%H:%M:%SZ)
r=$(req admin.jar POST /api/keys "{\"name\":\"$run-limited\"}")
[ "$(code "$r")" = 201 ] || fail "create limited key gave $(code "$r")"
k6_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" k6
r=$(req admin.jar PATCH "/api/keys/$k6_id" '{"rateLimitPerMin":3}')
[ "$(code "$r")" = 200 ] && [ "$(body "$r" | jq -r .key.rateLimitPerMin)" = 3 ] || fail "set the limit to 3 gave $(code "$r")"
rate_text='^Rate limit exceeded, retry in [0-9]+ s$'
for i in 1 2 3; do
  out=$(tools k6 main__get_info 2>&1) || fail "limited key, call $i of 3 failed: $out"
done
out=$(tools k6 main__get_info 2>&1) && fail "the 4th call on a key limited to 3 was not refused"
grep -Eq "$rate_text" <<<"$out" || fail "the 4th call answered: $out"
pass "a key limited to 3 gets 3 ok calls, then 'Rate limit exceeded, retry in N s' as a tool error"
out=$(tools k6 call_tool '{"name":"main__get_info"}' 2>&1) && fail "call_tool got past the limit"
grep -Eq "$rate_text" <<<"$out" || fail "call_tool answered: $out"
[ -n "$(list_names k6)" ] || fail "tools/list was refused for the limited key"
pass "call_tool is refused the same way, and tools/list still answers"
tools k2 main__get_info >/dev/null || fail "k2 main__get_info was limited"
pass "another key of the same user is not limited"
t0=$(date +%s%N)
until body "$(req admin.jar GET "/api/audit?user=$admin_id&outcome=rate_limited&from=$since_rl")" |
  jq -e 'any(.items[]; .exposedName == "main__get_info") and any(.items[]; (.errorMessage // "") | test("^Rate limit exceeded"))' >/dev/null; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "no rate_limited audit row for the limited key"
  sleep 0.2
done
pass "the audit API shows rate_limited rows"

# Disabling the member ends their session and drops both of their cached keys in the gateway at once.
for k in k3 k4; do [ "$(mcp_status "$k")" != 401 ] || fail "member key $k rejected before disable"; done
t0=$(date +%s%N)
[ "$(code "$(req admin.jar PATCH "/api/users/$member_id" '{"status":"disabled"}')")" = 200 ] || fail "disable member"
until [ "$(mcp_status k3)" = 401 ] && [ "$(mcp_status k4)" = 401 ]; do
  [ "$(ms_since "$t0")" -lt 1000 ] || fail "a disabled member's key is still accepted after 1 s"
  sleep 0.05
done
pass "both keys of the disabled member get 401 after $(ms_since "$t0") ms"
[ "$(code "$(req member.jar GET /api/me)")" = 401 ] || fail "disabled member's session still works"
pass "disabled member's session is gone"

# One agent turn as the admin. Free-tier LLMs can be rate limited; that skips only this check.
since_chat=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)
prompt=$(jq -nc --arg p 'Call the main__get_info tool and tell me the store name in one sentence.' \
  '{messages: [{role: "user", content: $p}]}')
out=$(curl -s -N --max-time 250 -b "$S/admin.jar" -H "origin: $APP" -H 'content-type: application/json' \
  --data-binary "$prompt" "$APP/api/chat")
last=$(grep '^event: ' <<<"$out" | tail -n1 || true)
err=$(grep -A1 '^event: error$' <<<"$out" | sed -n 's/^data: //p' || true)
if [ "$last" = 'event: error' ] && chat_rate_limited "$out"; then
  echo "SKIP: agent turn: $(jq -r .message <<<"$err")"
else
  [ "$last" = 'event: done' ] || fail "agent turn ended with '${last:-no events}' $err"
  grep -q '"name":"main__get_info"' <<<"$out" || fail "the agent did not call main__get_info"
  results=$(grep -A1 '^event: tool_result$' <<<"$out" || true)
  grep -q '"ok":true' <<<"$results" || fail "the agent's tool call failed"
  answer=$(awk '/^event: text$/ { getline; sub(/^data: /, ""); print }' <<<"$out" | jq -rj .delta)
  grep -qi 'main store' <<<"$answer" || fail "the agent's answer does not name the store: $answer"
  t0=$(date +%s%N)
  until body "$(req admin.jar GET "/api/audit?server=main&from=$since_chat")" |
    jq -e --arg a "$admin_email" 'any(.items[]; .via == "agent" and .userEmail == $a
      and .exposedName == "main__get_info" and .outcome == "ok")' >/dev/null; do
    [ "$(ms_since "$t0")" -lt 3000 ] || fail "no via=agent audit row for the agent's call"
    sleep 0.2
  done
  pass "the agent answered one tool-calling turn, audited via agent to $admin_email"
fi

for id in "$k2_id" "$k3_id" "$k4_id" "$k5_id" "$k6_id"; do req admin.jar DELETE "/api/keys/$id" >/dev/null; done
rm -f "$S"/k[1-6] "$S"/k[1-6].hdr "$S"/admin.jar "$S"/member.jar
pass "cleanup: e2e keys revoked, member disabled"
echo OK
