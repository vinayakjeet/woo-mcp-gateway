#!/usr/bin/env bash
# Puts the live system in the demo state: main, fx and gh enabled and connected, the member
# asha@example.com active, and exactly one live API key, named demo, owned by the admin.
# Orders, products, other users and the chat history (kept in each browser) are left alone.
# Needs kubectl, curl and jq. Secrets go to files under $S (mode 600) and are never printed.
#
# --reset-member-password sets a new random password for the member, written to
# $ASHA_PW_FILE (default deploy/secrets/asha.pw, git-ignored, mode 600). It runs the app's own
# argon2 hash inside the control-plane pod and updates that one user's password_hash, so use it
# for an account created earlier whose password nobody kept. There is no reset API.
set -euo pipefail
cd "$(dirname "$0")/.."

reset_pw=false
case "${1:-}" in
  --reset-member-password) reset_pw=true ;;
  '') ;;
  *) echo "usage: $0 [--reset-member-password]" >&2; exit 2 ;;
esac

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
DEMO_MEMBER=asha@example.com
PW_FILE=${ASHA_PW_FILE:-deploy/secrets/asha.pw}
umask 077
mkdir -p "$S"
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

# An interrupted e2e run can leave an upstream at zero replicas, and then it cannot connect.
for d in platform/fx-mcp store-main/woo-mcp; do
  ns=${d%/*} name=${d#*/}
  if [ "$(kubectl -n "$ns" get deploy "$name" -o jsonpath='{.spec.replicas}')" = 0 ]; then
    kubectl -n "$ns" scale deploy "$name" --replicas=1 >/dev/null
    echo "scaled $d back to 1"
  fi
  kubectl -n "$ns" rollout status deploy "$name" --timeout=120s >/dev/null
done

admin_login admin.jar

servers=$(body "$(req admin.jar GET /api/servers)")
for slug in main fx gh; do
  s=$(jq -c --arg s "$slug" '.servers[] | select(.slug == $s)' <<<"$servers")
  [ -n "$s" ] || fail "server $slug is not registered (gh: add it on the Servers page)"
  [ "$(jq -r .approval <<<"$s")" = approved ] || fail "server $slug is not approved"
  if [ "$(jq -r .enabled <<<"$s")" != true ]; then
    [ "$(code "$(req admin.jar PATCH "/api/servers/$(jq -r .id <<<"$s")" '{"enabled":true}')")" = 200 ] ||
      fail "enable $slug"
    echo "enabled $slug"
  fi
done
t0=$(date +%s%N)
until body "$(req admin.jar GET /api/servers)" | jq -e '[.servers[]
  | select(.slug == "main" or .slug == "fx" or .slug == "gh") | .status.state]
  | length == 3 and all(. == "connected")' >/dev/null; do
  if [ "$(ms_since "$t0")" -ge 60000 ]; then
    body "$(req admin.jar GET /api/servers)" |
      jq -r '.servers[] | "\(.slug): \(.status.state) \(.status.errorKind // "") \(.status.errorMessage // "")"' >&2
    fail "main, fx and gh are not all connected after 60 s"
  fi
  sleep 1
done
pass "main, fx and gh enabled and connected"

users=$(body "$(req admin.jar GET /api/users)")
asha=$(jq -c --arg e "$DEMO_MEMBER" '.users[] | select(.email == $e)' <<<"$users")
[ -n "$asha" ] || asha='{"status":"missing"}'
[ "$(jq -r .role <<<"$asha")" != admin ] || fail "$DEMO_MEMBER is an admin; change the role on the Members page"
case "$(jq -r .status <<<"$asha")" in
  active) ;;
  missing | invited)
    r=$(req admin.jar POST /api/invites "{\"email\":\"$DEMO_MEMBER\",\"role\":\"member\"}")
    [ "$(code "$r")" = 201 ] || fail "invite $DEMO_MEMBER gave $(code "$r")"
    token=$(body "$r" | jq -r .url | sed 's|.*/invite/||')
    head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$S/asha.pw"
    jq -n --rawfile pw "$S/asha.pw" '{password: $pw}' >"$S/asha-accept.json"
    r=$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $APP" -H 'content-type: application/json' \
      --data-binary @"$S/asha-accept.json" "$APP/api/invites/$token/accept")
    rm -f "$S/asha-accept.json"
    [ "$r" = 200 ] || fail "accepting the $DEMO_MEMBER invite gave $r"
    echo "created $DEMO_MEMBER; the password is in $S/asha.pw"
    ;;
  disabled)
    [ "$(code "$(req admin.jar PATCH "/api/users/$(jq -r .id <<<"$asha")" '{"status":"active"}')")" = 200 ] ||
      fail "re-enable $DEMO_MEMBER"
    echo "re-enabled $DEMO_MEMBER"
    ;;
esac
pass "$DEMO_MEMBER is an active member"

if $reset_pw; then
  mkdir -p "$(dirname "$PW_FILE")"
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$PW_FILE"
  chmod 600 "$PW_FILE"
  # The password and email travel on stdin, so they never reach argv or the pod's process list.
  jq -n --rawfile pw "$PW_FILE" --arg email "$DEMO_MEMBER" '{password: $pw, email: $email}' |
    kubectl -n platform exec -i deploy/control-plane -c control-plane -- node -e '
      const { hash } = require("@node-rs/argon2");
      const { Client } = require("pg");
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", async () => {
        const { password, email } = JSON.parse(raw);
        const db = new Client({ connectionString: process.env.DATABASE_URL });
        await db.connect();
        const r = await db.query(
          "update users set password_hash = $1 where email = $2 and role = $3 and status = $4",
          [await hash(password), email, "member", "active"],
        );
        await db.end();
        if (r.rowCount !== 1) { console.error("rows updated: " + r.rowCount); process.exit(1); }
      });
    ' || fail "could not set the $DEMO_MEMBER password"
  # Proves the new password works through the real login route.
  jq -n --rawfile pw "$PW_FILE" --arg e "$DEMO_MEMBER" '{email: $e, password: $pw}' >"$S/asha-login.json"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $APP" -H 'content-type: application/json' \
    --data-binary @"$S/asha-login.json" "$APP/api/auth/login")
  rm -f "$S/asha-login.json"
  [ "$r" = 200 ] || fail "login as $DEMO_MEMBER with the new password gave $r"
  pass "$DEMO_MEMBER password reset; it is in $PW_FILE"
fi

# Every live key except the newest admin key named demo goes: keys from test runs, smoke checks
# and earlier demos, of every user.
admin_id=$(body "$(req admin.jar GET /api/me)" | jq -r .user.id)
keep=$(body "$(req admin.jar GET "/api/users/$admin_id/keys")" |
  jq -r '[.keys[] | select(.revokedAt == null and .name == "demo")][0].id // empty')
revoked=0
for uid in $(body "$(req admin.jar GET /api/users)" | jq -r '.users[] | select(.activeKeys > 0) | .id'); do
  for kid in $(body "$(req admin.jar GET "/api/users/$uid/keys")" | jq -r '.keys[] | select(.revokedAt == null) | .id'); do
    [ "$kid" != "$keep" ] || continue
    [ "$(code "$(req admin.jar DELETE "/api/keys/$kid")")" = 204 ] || fail "revoke key $kid"
    revoked=$((revoked + 1))
  done
done
if [ -z "$keep" ]; then
  r=$(req admin.jar POST /api/keys '{"name":"demo"}')
  [ "$(code "$r")" = 201 ] || fail "create the demo key"
  save_key "$(body "$r")" demo.key
  echo "created the demo key: $S/demo.key (curl header file $S/demo.key.hdr)"
elif [ -f "$S/demo.key" ]; then
  echo "kept the demo key: $S/demo.key"
else
  echo "kept the demo key; its secret was shown once, when it was created"
fi
n=$(body "$(req admin.jar GET /api/users)" | jq '[.users[].activeKeys] | add')
[ "$n" = 1 ] || fail "$n live keys after the reset"
pass "revoked $revoked stray key(s); one live key remains, named demo"

req admin.jar POST /api/auth/logout >/dev/null
rm -f "$S/admin.jar"
echo OK
