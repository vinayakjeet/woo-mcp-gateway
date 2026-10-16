#!/usr/bin/env bash
# Live check for the chat agent (M6). Prints no passwords, cookies, tokens or keys.
# Usage: S=<private scratch dir> scripts/chat-check.sh
# On the VM: APP=https://app.vinayak-urum.me S=<private scratch dir> scripts/chat-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
NS=platform
source scripts/kube-context.sh

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }

umask 077
jar="$S/chat-jar"
login="$S/chat-login.json"
trap 'rm -f "$jar" "$login"' EXIT

kubectl -n "$NS" exec -i deploy/agent -- node --input-type=module - <scripts/llm-models.mjs ||
  fail "a configured model name is missing (see the candidates above)"
pass "both model names exist"

uid=$(kubectl -n "$NS" exec deploy/agent -- id -u)
[ "$uid" = 10001 ] || fail "agent runs as uid $uid"
if kubectl -n "$NS" exec deploy/agent -- touch /app/probe 2>/dev/null; then fail "root filesystem is writable"; fi
if kubectl -n "$NS" exec deploy/agent -- test -e /var/run/secrets/kubernetes.io/serviceaccount/token; then
  fail "service account token is mounted"
fi
pass "agent runs as 10001 with a read-only root and no service account token"

probe=$(kubectl -n "$NS" exec deploy/agent -- node -e '
const s = require("net").connect(5432, "postgres.platform.svc.cluster.local");
s.on("connect", () => { console.log("open"); process.exit(0); });
s.on("error", (e) => { console.log(e.code); process.exit(0); });
setTimeout(() => { console.log("timeout"); process.exit(0); }, 3000);')
# k3s rejects a blocked connection (ECONNREFUSED at once) instead of dropping it, so only "open" is a failure.
[ "$probe" != open ] || fail "agent reached postgres"
pass "agent cannot reach postgres"

email=$(kubectl -n "$NS" get secret platform-bootstrap -o jsonpath='{.data.ADMIN_EMAIL}' | base64 -d)
# The password goes from the Secret into a 0600 file through jq's stdin, never into argv.
kubectl -n "$NS" get secret platform-bootstrap -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d |
  jq -Rs --arg e "$email" '{email: $e, password: .}' >"$login"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H "Origin: $APP" \
  -H 'content-type: application/json' --data @"$login" "$APP/api/auth/login")
[ "$code" = 200 ] || fail "login answered $code"
pass "login as $email"

hi='{"messages":[{"role":"user","content":"hi"}]}'
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H 'content-type: application/json' \
  --data "$hi" "$APP/api/chat")
[ "$code" = 403 ] || fail "chat without Origin answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $APP" -H 'content-type: application/json' \
  --data "$hi" "$APP/api/chat")
[ "$code" = 401 ] || fail "chat without a session answered $code"
pass "chat needs the app Origin and a live session"

since=$(date -u -d '-5 seconds' +%Y-%m-%dT%H:%M:%SZ)
body=$(jq -nc --arg p 'Call the main__get_info tool and tell me the store name in one sentence.' \
  '{messages: [{role: "user", content: $p}]}')
out=$(curl -s -N --max-time 250 -b "$jar" -H "Origin: $APP" -H 'content-type: application/json' \
  --data "$body" "$APP/api/chat")
grep '^event: ' <<<"$out" | uniq -c
if [ "$(grep '^event: ' <<<"$out" | tail -1)" != "event: done" ]; then
  grep -A1 '^event: error$' <<<"$out" >&2 || true
  fail "turn did not end with done"
fi
grep -q '"name":"main__get_info"' <<<"$out" || fail "main__get_info was not called"
grep -A1 '^event: tool_result$' <<<"$out" | grep -q '"ok":true' || fail "tool result not ok"
grep -q '^event: text$' <<<"$out" || fail "no text events"
pass "chat called main__get_info through the gateway and answered"

audit=$(curl -s -b "$jar" "$APP/api/audit?server=main&from=$since")
n=$(jq --arg e "$email" '[.items[] | select(.via == "agent" and .userEmail == $e
  and .exposedName == "main__get_info" and .outcome == "ok")] | length' <<<"$audit")
[ "$n" -ge 1 ] || fail "no via=agent audit row for $email"
pass "audit has $n via=agent row(s) for $email"

for d in agent control-plane; do
  logs=$(kubectl -n "$NS" logs "deploy/$d" -c "$d" --since=15m)
  for pat in AIza gsk_ 'Bearer ' eyJ 'sid='; do
    [ "$(grep -c -- "$pat" <<<"$logs" || true)" -eq 0 ] || fail "$d log contains $pat"
  done
done
[ "$(kubectl -n "$NS" logs deploy/agent -c agent --since=15m | grep -c '"msg":"chat turn"' || true)" -ge 1 ] ||
  fail "no chat turn log line"
pass "no keys, tokens or cookies in the agent and control-plane logs"

echo OK
