#!/usr/bin/env bash
# Live checks for the dashboard API against the cluster: login, keys, a revoked key rejected
# within 1 s, server disable and enable, invites, member audit scoping and the Origin check.
# Needs kubectl, curl, jq and pnpm. Secrets go to files under $S (mode 600) and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
umask 077
mkdir -p "$S"
run=e2e-$(date +%s)

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }
ms_since() { echo $((($(date +%s%N) - $1) / 1000000)); }

# req JAR METHOD PATH [JSON]: the body, then the status code on its own last line.
req() {
  local args=(-s -b "$S/$1" -c "$S/$1" -H "origin: $APP" -X "$2" -w '\n%{http_code}')
  if [ $# -ge 4 ]; then args+=(-H 'content-type: application/json' --data-binary "$4"); fi
  curl "${args[@]}" "$APP$3"
}
body() { sed '$d' <<<"$1"; }
code() { tail -n1 <<<"$1"; }

# The bare key goes to $S/NAME and a curl header file to $S/NAME.hdr. printf is a builtin, so the
# key never shows up in a process list here.
save_key() {
  jq -r '.secret' <<<"$1" >"$S/$2"
  printf 'authorization: Bearer %s\n' "$(cat "$S/$2")" >"$S/$2.hdr"
}
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

# Admin login: the password goes from the Secret into a body file, never into argv or stdout.
kubectl -n platform get secret platform-bootstrap -o json |
  jq '{email: (.data.ADMIN_EMAIL | @base64d), password: (.data.ADMIN_PASSWORD | @base64d)}' >"$S/admin-login.json"
r=$(curl -s -c "$S/admin.jar" -H "origin: $APP" -H 'content-type: application/json' \
  --data-binary @"$S/admin-login.json" -w '\n%{http_code}' "$APP/api/auth/login")
rm -f "$S/admin-login.json"
[ "$(code "$r")" = 200 ] || fail "admin login gave $(code "$r")"
[ "$(body "$(req admin.jar GET /api/me)" | jq -r .user.role)" = admin ] || fail "/api/me"
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
t0=$(date +%s%N)
[ "$(code "$(req admin.jar PATCH "/api/servers/$fx_id" '{"enabled":false}')")" = 200 ] || fail "disable fx"
until [ "$(count_prefix k2 fx)" -eq 0 ]; do
  [ "$(ms_since "$t0")" -lt 5000 ] || fail "fx tools still listed 5 s after disable"
done
pass "disabled fx: its tools are gone after $(ms_since "$t0") ms"
[ "$(code "$(req admin.jar PATCH "/api/servers/$fx_id" '{"enabled":true}')")" = 200 ] || fail "enable fx"
t0=$(date +%s%N)
until [ "$(count_prefix k2 fx)" -ge 1 ]; do
  [ "$(ms_since "$t0")" -lt 10000 ] || fail "fx tools not back 10 s after enable"
  sleep 0.5
done
pass "enabled fx: its tools are back"

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
tools k3 fx__get_info >/dev/null || fail "member call fx__get_info"
tools k2 fx__get_info >/dev/null || fail "admin call fx__get_info"

t0=$(date +%s%N)
until body "$(req member.jar GET /api/audit)" |
  jq -e --arg e "$run@example.com" '(.items | length) > 0 and all(.items[]; .userEmail == $e)' >/dev/null; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "member audit rows"
  sleep 0.2
done
pass "the member sees only their own audit rows"
body "$(req admin.jar GET "/api/audit?user=$member_id")" | jq -e '.items[0].exposedName == "fx__get_info"' >/dev/null ||
  fail "admin view of the member's rows"
body "$(req admin.jar GET '/api/audit?server=fx')" |
  jq -e --arg e "$run@example.com" '[.items[].userEmail] | (index($e) != null) and any(.[]; . != $e)' >/dev/null ||
  fail "admin sees every user's rows"
pass "the admin sees every user's rows and can filter by user"

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

for id in "$k2_id" "$k3_id" "$k4_id"; do req admin.jar DELETE "/api/keys/$id" >/dev/null; done
rm -f "$S"/k[1-4] "$S"/k[1-4].hdr "$S"/admin.jar "$S"/member.jar
pass "cleanup: e2e keys revoked, member disabled"
echo OK
