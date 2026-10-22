#!/usr/bin/env bash
# Live check for metrics, request ids and trace context (M12) on k3d. One tools/call goes through
# the Ingress with a traceparent header. Its trace id must show in the gateway and woo-mcp logs, its
# request id in the audit row. Prints no passwords, cookies, tokens or keys.
# Usage: S=<private scratch dir> scripts/obs-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
umask 077
mkdir -p "$S"
run=obs-$(date +%s)
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

psql_one() { kubectl -n platform exec postgres-0 -- psql -U platform -d platform -At -c "$1"; }
pids=()
key_id=""
member_id=""
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ -n "$key_id" ]; then req admin.jar DELETE "/api/keys/$key_id" >/dev/null 2>&1 || true; fi
  if [ -n "$member_id" ]; then
    req admin.jar PATCH "/api/users/$member_id" '{"status":"disabled"}' >/dev/null 2>&1 || true
  fi
  rm -f "$S"/obs-*.json "$S"/obs-member.pw "$S/obs-key" "$S/obs-key.hdr" "$S/obs-headers" "$S"/obs-*.txt
}
trap cleanup EXIT

forward() {
  kubectl -n platform port-forward "$1" "$2:$3" >/dev/null 2>&1 &
  pids+=($!)
  local i
  for i in $(seq 1 20); do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$2/healthz"; then return 0; fi
    sleep 0.5
  done
  fail "port-forward to $1 did not come up"
}
# Every gateway replica gets its own forward: a call through the Ingress can land on any of them.
gwports=()
port=19090
for pod in $(kubectl -n platform get pods -l app.kubernetes.io/name=gateway -o name); do
  forward "$pod" "$port" 9090
  gwports+=("$port")
  port=$((port + 1))
done
[ "${#gwports[@]}" -ge 1 ] || fail "no gateway pods"
forward svc/control-plane-internal 13001 3001

gw_metrics() { for pt in "${gwports[@]}"; do curl -s --max-time 5 "http://127.0.0.1:$pt/metrics"; done; }
gw_logs() { kubectl -n platform logs -l app.kubernetes.io/name=gateway --max-log-requests=10 "$@"; }
# The sum over replicas of one counter row.
main_ok() {
  gw_metrics | awk '/^gateway_tool_calls_total\{server="main",outcome="ok"\} / { s += $2 } END { print s + 0 }'
}
cp_metrics() { curl -s --max-time 5 http://127.0.0.1:13001/metrics; }

gm=$(gw_metrics)
for n in gateway_tool_calls_total gateway_tool_call_duration_seconds gateway_upstream_up gateway_tools_exposed; do
  grep -q "^# TYPE $n " <<<"$gm" || fail "gateway /metrics lacks $n"
done
cm=$(cp_metrics)
for n in provisioner_stores provisioner_duration_seconds; do
  grep -q "^# TYPE $n " <<<"$cm" || fail "control-plane /metrics lacks $n"
done
grep -q '^provisioner_stores{status="ready"} ' <<<"$cm" || fail "provisioner_stores has no ready row"
pass "both /metrics endpoints list the documented names"

# Counts, durations and labels only.
for text in "$gm" "$cm"; do
  for pat in '@' 'Bearer' eyJ 'sid=' 'password' 'secret'; do
    ! grep -qi -- "$pat" <<<"$text" || fail "a /metrics body contains $pat"
  done
done
pass "/metrics bodies hold no emails, tokens, cookies or secrets"

# The Ingress routes neither metrics port.
for url in "$APP/metrics" "$APP/api/metrics" "${MCP%/mcp}/metrics"; do
  out=$(curl -s --max-time 5 "$url" || true)
  ! grep -q '^# TYPE ' <<<"$out" || fail "$url serves metrics"
done
pass "no Ingress host serves /metrics"

admin_login admin.jar
r=$(req admin.jar POST /api/keys "{\"name\":\"$run\"}")
[ "$(code "$r")" = 201 ] || fail "create key"
key_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" obs-key

before=$(main_ok)

trace=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
tp="00-$trace-00f067aa0ba902b7-01"
out=$(curl -s -D "$S/obs-headers" -X POST "$MCP" -H @"$S/obs-key.hdr" -H "traceparent: $tp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' --data-binary \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"main__get_info","arguments":{}}}')
head -1 "$S/obs-headers" | grep -q ' 200' || fail "tools/call did not answer 200"
grep -q '"isError":true' <<<"$out" && fail "main__get_info returned a tool error"
rid=$(tr -d '\r' <"$S/obs-headers" | sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p')
[[ "$rid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
  fail "x-request-id is not a UUID: $rid"
pass "tools/call answered 200 with x-request-id $rid"

# The id comes from the server: a client value is ignored.
curl -s -o /dev/null -D "$S/obs-headers" -X POST "$MCP" -H @"$S/obs-key.hdr" \
  -H 'x-request-id: chosen-by-client' -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
! grep -qi 'chosen-by-client' "$S/obs-headers" || fail "a client x-request-id was echoed"
pass "a client x-request-id is ignored"

seen_gw=0
seen_woo=0
for _ in $(seq 1 20); do
  [ "$seen_gw" = 1 ] || { gw_logs --since=2m | grep -q "\"trace_id\":\"$trace\"" && seen_gw=1; } || true
  [ "$seen_woo" = 1 ] || { kubectl -n store-main logs deploy/woo-mcp --since=2m | grep -q "\"trace_id\":\"$trace\"" && seen_woo=1; } || true
  [ "$seen_gw$seen_woo" = 11 ] && break
  sleep 0.5
done
[ "$seen_gw" = 1 ] || fail "trace id not in the gateway log"
[ "$seen_woo" = 1 ] || fail "trace id not in the woo-mcp log"
pass "trace id $trace is in the gateway and woo-mcp logs"

line=$(gw_logs --since=2m | grep "\"trace_id\":\"$trace\"" | head -1)
jq -e --arg r "$rid" '.request_id == $r and .server == "main" and .tool == "get_info" and .outcome == "ok"' \
  <<<"$line" >/dev/null || fail "gateway call line lacks the request id, server, tool or outcome"
pass "the gateway call line carries the same request id"

n=$(psql_one "select count(*) from audit_events where request_id = '$rid' and outcome = 'ok'
  and server_slug = 'main'")
[ "$n" = 1 ] || fail "expected one ok audit row for request id $rid, found $n"
pass "audit row with request_id $rid exists"

# Neither the key nor the call arguments appear in the logs that took part.
for who in gateway woo-mcp; do
  if [ "$who" = gateway ]; then logs=$(gw_logs --since=5m); else logs=$(kubectl -n store-main logs deploy/woo-mcp --since=5m); fi
  ! grep -qFf "$S/obs-key" <<<"$logs" || fail "the API key is in the $who log"
done
pass "the API key is not in the gateway or woo-mcp logs"

after=0
for _ in $(seq 1 10); do
  after=$(main_ok)
  [ "$after" -ge $((before + 1)) ] && break
  sleep 0.5
done
[ "$after" -ge $((before + 1)) ] || fail "gateway_tool_calls_total{main,ok} stayed at $before"
# Captured first: grep -q closes the pipe early and pipefail would fail the pipeline.
hist=$(gw_metrics)
grep -q '^gateway_tool_call_duration_seconds_count{server="main"} ' <<<"$hist" ||
  fail "no duration histogram for main"
pass "gateway_tool_calls_total{server=main,outcome=ok} grew from $before to $after"

r=$(req admin.jar GET "/api/stats/servers?window=60m")
[ "$(code "$r")" = 200 ] || fail "stats as admin gave $(code "$r")"
calls=$(body "$r" | jq '[.servers[] | select(.slug == "main")][0].calls')
[ "${calls:-0}" -ge 1 ] || fail "stats list main with $calls calls"
pass "stats as admin list main with $calls calls"

r=$(req admin.jar POST /api/invites "{\"email\":\"$run@example.com\",\"role\":\"member\"}")
[ "$(code "$r")" = 201 ] || fail "invite"
token=$(body "$r" | jq -r .url | sed 's|.*/invite/||')
head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$S/obs-member.pw"
jq -n --rawfile pw "$S/obs-member.pw" '{password: $pw}' >"$S/obs-accept.json"
r=$(curl -s -c "$S/member.jar" -H "origin: $APP" -H 'content-type: application/json' \
  --data-binary @"$S/obs-accept.json" -w '\n%{http_code}' "$APP/api/invites/$token/accept")
[ "$(code "$r")" = 200 ] || fail "accept invite gave $(code "$r")"
member_id=$(body "$r" | jq -r .user.id)
r=$(req member.jar GET "/api/stats/servers")
[ "$(code "$r")" = 200 ] || fail "stats as member gave $(code "$r")"
body "$r" | jq -e '.windowMinutes == 60 and (.servers | length) >= 1' >/dev/null || fail "member stats shape"
! grep -q '@' <<<"$(body "$r")" || fail "member stats contain an email"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/api/stats/servers")" = 401 ] || fail "stats without a session"
pass "stats as a member answer 200 without emails; no session gives 401"

echo OK
