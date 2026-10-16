#!/usr/bin/env bash
# Live checks of the OAuth flow (M13, SPEC 24): both metadata documents, the 401 challenge, client
# registration, the consent page and its CSRF and Origin checks, the code exchange with PKCE, a
# call through the gateway audited via oauth, rotating refresh tokens with the 30 s grace window,
# a disabled member, and a grep of the live logs for secrets. A throwaway member is invited, used
# and disabled, like e2e.sh. Needs kubectl, curl, jq, openssl and pnpm.
# Codes, verifiers, tokens and cookies live in mode 600 files under $S. They are sent with
# --data-binary @file or -H @file, so none is in a process list, and none is printed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S:?set S to a private scratch directory}"
APP=${APP:-http://app.127.0.0.1.nip.io}
MCP=${MCP:-http://mcp.127.0.0.1.nip.io/mcp}
GW=${MCP%/mcp}
umask 077
mkdir -p "$S"
run=oc-$(date +%s)
start_ts=$(date -u -d '-2 seconds' +%Y-%m-%dT%H:%M:%SZ)
# shellcheck source=scripts/api-lib.sh
source scripts/api-lib.sh

REDIRECT=http://127.0.0.1:53682/callback
REDIRECT_ENC=$(jq -rn --arg v "$REDIRECT" '$v | @uri')
RES_ENC=$(jq -rn --arg v "$MCP" '$v | @uri')
ISS_ENC=$(jq -rn --arg v "$APP" '$v | @uri')
RPC_LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

member_id=''
key_id=''
cleanup() {
  local rc=$?
  if [ -n "$member_id" ]; then
    curl -s -o /dev/null -b "$S/oc-admin.jar" -H "origin: $APP" -H 'content-type: application/json' \
      -X PATCH --data-binary '{"status":"disabled"}' "$APP/api/users/$member_id" || true
  fi
  if [ -n "$key_id" ]; then
    curl -s -o /dev/null -b "$S/oc-admin.jar" -H "origin: $APP" -X DELETE "$APP/api/keys/$key_id" || true
  fi
  rm -f "$S"/oc-*
  exit "$rc"
}
trap cleanup EXIT

psql_one() { kubectl -n platform exec postgres-0 -- psql -U platform -d platform -At -c "$1"; }
tools() { pnpm -s tsx scripts/mcp-smoke.ts "$MCP" "$(cat "$S/$1")" "${@:2}"; }
rand_url() { head -c "$1" /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '='; }
challenge_of() { openssl dgst -sha256 -binary <"$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
# hdr FILE NAME: one response header value.
hdr() { { grep -i "^$2:" "$1" || true; } | head -n1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r' || true; }
# bearer FILE: the header file for a token kept in $S/FILE.
bearer() { printf 'authorization: Bearer %s\n' "$(cat "$S/$1")" >"$S/$1.hdr"; }
# probe FILE: one tools/list with the bearer header file; headers go to oc-probe.hdr.
probe() {
  curl -s -D "$S/oc-probe.hdr" -o /dev/null -w '%{http_code}' -X POST "$MCP" -H @"$S/$1.hdr" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data-binary "$RPC_LIST"
}
# tok K=V ...: one form POST to the token endpoint. The status is printed, the body is oc-tok.out.
tok() {
  local IFS='&'
  printf '%s' "$*" >"$S/oc-tok.body"
  curl -s -o "$S/oc-tok.out" -w '%{http_code}' -X POST "$APP/oauth/token" \
    -H 'content-type: application/x-www-form-urlencoded' --data-binary @"$S/oc-tok.body"
}
tok_error() { jq -r '.error // empty' "$S/oc-tok.out"; }

# browser_origin HEADERFILE: the Origin a browser sends when a form on that page posts. A form post
# is a navigation, not a CORS request, so the page's own headers decide (Fetch spec, "append a
# request Origin header"): no-referrer, or a CSP sandbox without allow-same-origin, makes it "null".
# curl would send whatever it is told, which is how a bad Referrer-Policy once passed this script.
browser_origin() {
  local policy csp
  policy=$(hdr "$1" referrer-policy)
  csp=$(hdr "$1" content-security-policy)
  if [ "$policy" = no-referrer ]; then
    echo null
  elif grep -qE '(^|;)[[:space:]]*sandbox' <<<"$csp" && ! grep -q allow-same-origin <<<"$csp"; then
    echo null
  else
    echo "$APP"
  fi
}
# open_consent NAME: a fresh PKCE pair, then the consent page. Sets Q (the query), ST, CSRF, and
# BROWSER_ORIGIN and BROWSER_REFERER, which a browser would send with the form post.
open_consent() {
  rand_url 32 >"$S/oc-$1.verifier"
  ST=$(rand_url 12)
  Q="response_type=code&client_id=$CID&redirect_uri=$REDIRECT_ENC&code_challenge=$(challenge_of "$S/oc-$1.verifier")&code_challenge_method=S256&scope=mcp%3Atools&resource=$RES_ENC&state=$ST"
  [ "$(curl -s -D "$S/oc-az.hdr" -o "$S/oc-az.html" -w '%{http_code}' -b "$S/oc-member.jar" "$APP/oauth/authorize?$Q")" = 200 ] ||
    fail "consent page for $1"
  CSRF=$(sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' "$S/oc-az.html")
  [ -n "$CSRF" ] || fail "no csrf field on the consent page"
  BROWSER_ORIGIN=$(browser_origin "$S/oc-az.hdr")
  BROWSER_REFERER=''
  [ "$(hdr "$S/oc-az.hdr" referrer-policy)" = no-referrer ] || BROWSER_REFERER="$APP/oauth/authorize?$Q"
}
# post_consent FORM_SUFFIX [ORIGIN]: the consent form, with the headers Chrome sends for it
# (Origin and Referer from the page's policy; it adds no Sec-Fetch-* to a plain-http host that is
# not localhost). An explicit ORIGIN replaces them, for the rows that send a foreign or null one. Headers go to oc-az.hdr, the body to oc-az.out.
post_consent() {
  local origin=${2-$BROWSER_ORIGIN} referer=()
  if [ $# -lt 2 ] && [ -n "$BROWSER_REFERER" ]; then referer=(-H "referer: $BROWSER_REFERER"); fi
  printf '%s&%s' "$Q" "$1" >"$S/oc-az.body"
  curl -s -D "$S/oc-az.hdr" -o "$S/oc-az.out" -w '%{http_code}' -b "$S/oc-member.jar" \
    -H "origin: $origin" ${referer[@]+"${referer[@]}"} \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-binary @"$S/oc-az.body" "$APP/oauth/authorize"
}
# grant_code NAME: consent and Approve. Leaves oc-NAME.verifier and oc-NAME.code.
grant_code() {
  open_consent "$1"
  [ "$(post_consent "csrf=$CSRF&decision=approve")" = 303 ] || fail "approve for $1 did not answer 303"
  local loc
  loc=$(hdr "$S/oc-az.hdr" location)
  case "$loc" in "$REDIRECT?"*) ;; *) fail "approve for $1 did not return to the redirect URI" ;; esac
  case "$loc" in *"state=$ST"*) ;; *) fail "approve for $1 lost the state" ;; esac
  case "$loc" in *"iss=$ISS_ENC"*) ;; *) fail "approve for $1 has no iss" ;; esac
  sed -n 's/.*[?&]code=\([^&]*\).*/\1/p' <<<"$loc" | tr -d '\n' >"$S/oc-$1.code"
  [ -s "$S/oc-$1.code" ] || fail "approve for $1 gave no code"
}
# redeem NAME: the code and verifier of a grant_code run. The status is printed.
redeem() {
  tok grant_type=authorization_code "client_id=$CID" "code=$(cat "$S/oc-$1.code")" \
    "redirect_uri=$REDIRECT_ENC" "code_verifier=$(cat "$S/oc-$1.verifier")"
}
# keep NAME: splits oc-tok.out into oc-NAME-at and oc-NAME-rt and makes the header file.
keep() {
  jq -r .access_token "$S/oc-tok.out" | tr -d '\n' >"$S/oc-$1-at"
  jq -r .refresh_token "$S/oc-tok.out" | tr -d '\n' >"$S/oc-$1-rt"
  bearer "oc-$1-at"
}
refresh() { tok grant_type=refresh_token "client_id=$CID" "refresh_token=$(cat "$S/oc-$1-rt")"; }

admin_login oc-admin.jar

# 1. Discovery.
for p in /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp; do
  [ "$(curl -s -D "$S/oc-h" -o "$S/oc-b" -w '%{http_code}' -H 'origin: http://localhost:6274' "$GW$p")" = 200 ] ||
    fail "PRM $p did not answer 200"
  jq -e --arg r "$MCP" --arg a "$APP" '.resource == $r and .authorization_servers == [$a]
    and .scopes_supported == ["mcp:tools"] and .bearer_methods_supported == ["header"]
    and .resource_name == "Urumi MCP gateway"' "$S/oc-b" >/dev/null || fail "PRM $p body"
  [ "$(hdr "$S/oc-h" access-control-allow-origin)" = '*' ] || fail "PRM $p has no open CORS"
done
pass "protected resource metadata at both paths, with open CORS"

[ "$(curl -s -D "$S/oc-h" -o "$S/oc-b" -w '%{http_code}' -H 'origin: http://localhost:6274' \
  "$APP/.well-known/oauth-authorization-server")" = 200 ] || fail "AS metadata"
jq -e --arg a "$APP" '.issuer == $a and .authorization_endpoint == ($a + "/oauth/authorize")
  and .token_endpoint == ($a + "/oauth/token") and .registration_endpoint == ($a + "/oauth/register")
  and .code_challenge_methods_supported == ["S256"] and .token_endpoint_auth_methods_supported == ["none"]
  and .authorization_response_iss_parameter_supported == true' "$S/oc-b" >/dev/null || fail "AS metadata body"
[ "$(hdr "$S/oc-h" access-control-allow-origin)" = '*' ] || fail "AS metadata has no open CORS"
pass "authorization server metadata: issuer $APP, code_challenge_methods_supported exactly S256"

pre=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$APP/oauth/token" -H 'origin: http://localhost:6274' \
  -H 'access-control-request-method: POST' -H 'access-control-request-headers: content-type' -D "$S/oc-h")
case "$pre" in 200 | 204) ;; *) fail "token preflight answered $pre" ;; esac
[ "$(hdr "$S/oc-h" access-control-allow-origin)" = '*' ] || fail "token preflight has no open CORS"
pass "the token endpoint answers a browser preflight"

# 2. The challenge a client discovers from.
post_mcp() {
  curl -s -D "$S/oc-h" -o /dev/null -w '%{http_code}' -X POST "$MCP" "$@" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary "$RPC_LIST"
}
want="Bearer resource_metadata=\"$GW/.well-known/oauth-protected-resource\", scope=\"mcp:tools\""
[ "$(post_mcp)" = 401 ] || fail "POST /mcp with no token is not 401"
[ "$(hdr "$S/oc-h" www-authenticate)" = "$want" ] || fail "401 challenge is '$(hdr "$S/oc-h" www-authenticate)'"
[ "$(post_mcp -H 'authorization: Bearer not-a-token')" = 401 ] || fail "a bad token is not 401"
want_bad="Bearer error=\"invalid_token\", resource_metadata=\"$GW/.well-known/oauth-protected-resource\", scope=\"mcp:tools\""
[ "$(hdr "$S/oc-h" www-authenticate)" = "$want_bad" ] || fail "a rejected token's challenge is '$(hdr "$S/oc-h" www-authenticate)'"
pass "401 carries WWW-Authenticate with resource_metadata and scope, plus error=invalid_token for a bad token"

# 3. Registration.
register() {
  curl -s -o "$S/oc-b" -w '%{http_code}' -X POST "$APP/oauth/register" -H 'content-type: application/json' \
    --data-binary "$1"
}
[ "$(register "{\"client_name\":\"oauth-check\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}")" = 201 ] ||
  fail "registration"
CID=$(jq -r .client_id "$S/oc-b")
case "$CID" in dcr_*) ;; *) fail "client_id '$CID' is not dcr_..." ;; esac
pass "registration with no Origin header gave $CID"
[ "$(register '{"client_name":"x","redirect_uris":["http://evil.example/cb"]}')" = 400 ] &&
  [ "$(jq -r .error "$S/oc-b")" = invalid_redirect_uri ] || fail "an http non-loopback redirect was not refused"
[ "$(register "{\"client_name\":\"x\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"client_secret_basic\"}")" = 400 ] &&
  [ "$(jq -r .error "$S/oc-b")" = invalid_client_metadata ] || fail "client_secret_basic was not refused"
pass "registration refuses an http non-loopback redirect and client_secret_basic"

# 4. Authorize without a session.
q0="response_type=code&client_id=$CID&redirect_uri=$REDIRECT_ENC&code_challenge=$(rand_url 32 | openssl dgst -sha256 -binary | base64 -w0 | tr '+/' '-_' | tr -d '=')&code_challenge_method=S256&scope=mcp%3Atools&resource=$RES_ENC&state=none"
[ "$(curl -s -D "$S/oc-h" -o /dev/null -w '%{http_code}' "$APP/oauth/authorize?$q0")" = 302 ] || fail "authorize with no session"
case "$(hdr "$S/oc-h" location)" in /login?next=%2Foauth%2Fauthorize%3F*) ;; *) fail "authorize did not send the user to /login?next=" ;; esac
pass "authorize with no session redirects to /login?next=<authorize path>"

# 5. A throwaway member, as in e2e.
r=$(req oc-admin.jar POST /api/invites "{\"email\":\"$run@example.com\",\"role\":\"member\"}")
[ "$(code "$r")" = 201 ] || fail "invite"
itoken=$(body "$r" | jq -r .url | sed 's|.*/invite/||')
rand_url 18 >"$S/oc-member.pw"
jq -n --rawfile pw "$S/oc-member.pw" '{password: $pw}' >"$S/oc-accept.json"
r=$(curl -s -c "$S/oc-member.jar" -H "origin: $APP" -H 'content-type: application/json' \
  --data-binary @"$S/oc-accept.json" -w '\n%{http_code}' "$APP/api/invites/$itoken/accept")
rm -f "$S/oc-accept.json" "$S/oc-member.pw"
[ "$(code "$r")" = 200 ] || fail "accept invite gave $(code "$r")"
member_id=$(body "$r" | jq -r .user.id)
pass "member $run@example.com invited and signed in"

# 6. Authorize refusals, decision 7. A bad client or redirect is a page; the rest redirect back.
authz() { curl -s -D "$S/oc-h" -o "$S/oc-az.html" -w '%{http_code}' -b "$S/oc-member.jar" "$APP/oauth/authorize?$1"; }
unknown=${q0/client_id=$CID/client_id=dcr_doesnotexist}
[ "$(authz "$unknown")" = 400 ] && [ -z "$(hdr "$S/oc-h" location)" ] || fail "an unknown client was not a plain 400 page"
other=${q0/redirect_uri=$REDIRECT_ENC/redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Felsewhere}
[ "$(authz "$other")" = 400 ] && [ -z "$(hdr "$S/oc-h" location)" ] || fail "a redirect_uri mismatch was not a plain 400 page"
refused() { # QUERY ERROR
  [ "$(authz "$1")" = 302 ] || fail "$2: authorize did not redirect"
  local loc
  loc=$(hdr "$S/oc-h" location)
  case "$loc" in "$REDIRECT?"*"error=$2"*"state=none"*"iss=$ISS_ENC"*) ;; *) fail "$2: bad redirect '$loc'" ;; esac
}
refused "${q0/code_challenge_method=S256/code_challenge_method=plain}" invalid_request
refused "${q0/resource=$RES_ENC/resource=https%3A%2F%2Fevil.example%2Fmcp}" invalid_target
pass "authorize refuses an unknown client and a redirect mismatch with a page, plain PKCE and a foreign resource by redirect"

# 7. The consent page.
open_consent csrf-probe
for needle in "oauth-check" "unverified, self-registered" "$REDIRECT" "$run@example.com"; do
  grep -qF -- "$needle" "$S/oc-az.html" || fail "consent page lacks '$needle'"
done
csp=$(hdr "$S/oc-az.hdr" content-security-policy)
case "$csp" in *"form-action 'self' http://127.0.0.1:53682"*) ;; *) fail "consent CSP form-action is wrong: '$csp'" ;; esac
case "$csp" in *"frame-ancestors 'none'"*) ;; *) fail "consent CSP lacks frame-ancestors 'none'" ;; esac
[ "$(hdr "$S/oc-az.hdr" x-frame-options)" = DENY ] || fail "consent page can be framed"
[ "$(hdr "$S/oc-az.hdr" cache-control)" = no-store ] || fail "consent page is cacheable"
! grep -qi '<script' "$S/oc-az.html" || fail "consent page has a script"
pass "consent page names the client as unverified, shows the redirect URI and email; CSP, X-Frame-Options and no-store set, no script"

# The page must let a browser send the real Origin. The checks below then fail for the reason named.
[ "$BROWSER_ORIGIN" = "$APP" ] ||
  fail "a browser would post Origin: $BROWSER_ORIGIN from the consent page (Referrer-Policy '$(hdr "$S/oc-az.hdr" referrer-policy)')"
pass "the consent page lets a browser send the app origin on the form post (Referrer-Policy $(hdr "$S/oc-az.hdr" referrer-policy))"

[ "$(post_consent 'decision=approve')" = 403 ] && grep -q 'no longer valid' "$S/oc-az.out" ||
  fail "a consent POST with the browser's Origin and no CSRF token was not refused by the CSRF check"
[ "$(post_consent "csrf=$CSRF&decision=approve" http://evil.example)" = 403 ] && grep -q bad_origin "$S/oc-az.out" ||
  fail "a consent POST from a foreign Origin was not refused as bad_origin"
[ "$(post_consent "csrf=$CSRF&decision=approve" null)" = 403 ] && grep -q bad_origin "$S/oc-az.out" ||
  fail "a consent POST with Origin: null and a valid token was not refused as bad_origin"
pass "the consent POST is refused for its own reason: no CSRF token, a foreign Origin, and Origin: null with a valid token"

# 8. Codes and PKCE.
grant_code bad
rand_url 32 >"$S/oc-other.verifier"
[ "$(tok grant_type=authorization_code "client_id=$CID" "code=$(cat "$S/oc-bad.code")" "redirect_uri=$REDIRECT_ENC" \
  "code_verifier=$(cat "$S/oc-other.verifier")")" = 400 ] && [ "$(tok_error)" = invalid_grant ] || fail "a wrong verifier was not invalid_grant"
[ "$(redeem bad)" = 400 ] && [ "$(tok_error)" = invalid_grant ] || fail "a code survived a failed attempt"
pass "a wrong verifier is invalid_grant, and it spends the code"

grant_code g1
[ "$(redeem g1)" = 200 ] || fail "the code exchange failed"
jq -e '.token_type == "Bearer" and .expires_in == 900 and .scope == "mcp:tools" and (.refresh_token | startswith("urt_"))' \
  "$S/oc-tok.out" >/dev/null || fail "token response shape"
cp "$S/oc-tok.out" "$S/oc-first.json"
keep g1
[ "$(redeem g1)" = 400 ] && [ "$(tok_error)" = invalid_grant ] || fail "a code was redeemed twice"
pass "the right verifier gives Bearer tokens (900 s), and the same code again is invalid_grant"

# 9. A call through the gateway.
[ "$(probe oc-g1-at)" = 200 ] || fail "the access token was refused by the gateway"
out=$(tools oc-g1-at)
grep -q '^main__get_info' <<<"$out" || fail "the member's tool list has no main__get_info"
! grep -q '^main__create_product' <<<"$out" || fail "the member sees main__create_product"
tools oc-g1-at main__get_info >/dev/null || fail "main__get_info through the OAuth token"
t0=$(date +%s%N)
until [ "$(psql_one "select via || '|' || (api_key_id is null)::text from audit_events
  where user_id = '$member_id' and exposed_name = 'main__get_info' order by ts desc, id desc limit 1")" = 'oauth|true' ]; do
  [ "$(ms_since "$t0")" -lt 3000 ] || fail "no via=oauth audit row with a null key id"
  sleep 0.2
done
pass "the member lists their tools and calls main__get_info with the token, audited via oauth with no key id"

replicas=''
for _ in 1 2 3 4 5 6; do
  probe oc-g1-at >/dev/null
  replicas="$replicas $(hdr "$S/oc-probe.hdr" x-gateway-replica)"
done
replicas=$(tr ' ' '\n' <<<"$replicas" | sort -u | grep -v '^$' | tr '\n' ' ' || true)
[ -n "$replicas" ] || fail "no x-gateway-replica header on the gateway answers"
pass "the token verified on gateway pod(s): ${replicas% }"

# 10. Rotation and the 30 s grace window.
[ "$(refresh g1)" = 200 ] || fail "refresh"
cp "$S/oc-tok.out" "$S/oc-r1.json"
jq -r .refresh_token "$S/oc-r1.json" | tr -d '\n' >"$S/oc-g2-rt"
jq -r .access_token "$S/oc-r1.json" | tr -d '\n' >"$S/oc-g2-at"
bearer oc-g2-at
! cmp -s "$S/oc-g2-rt" "$S/oc-g1-rt" || fail "refresh returned the same refresh token"
[ "$(probe oc-g2-at)" = 200 ] || fail "the refreshed access token was refused"
pass "refresh rotates: a new refresh token, and the new access token works"

[ "$(refresh g1)" = 200 ] || fail "a replay of the previous refresh token inside 30 s was refused"
cmp -s "$S/oc-tok.out" "$S/oc-r1.json" || fail "the replay did not return the same pair"
pass "the previous refresh token again inside 30 s returns the same pair, byte for byte"

[ "$(refresh g2)" = 200 ] || fail "second refresh"
jq -r .refresh_token "$S/oc-tok.out" | tr -d '\n' >"$S/oc-g3-rt"
[ "$(refresh g1)" = 400 ] && [ "$(tok_error)" = invalid_grant ] || fail "a refresh token two generations old was not invalid_grant"
[ "$(tok grant_type=refresh_token "client_id=$CID" "refresh_token=$(cat "$S/oc-g3-rt")")" = 400 ] &&
  [ "$(tok_error)" = invalid_grant ] || fail "the live refresh token survived a reuse"
pass "a token two generations old is invalid_grant and revokes the live token"

grant_code h1
[ "$(redeem h1)" = 200 ] || fail "second grant"
keep h1
[ "$(refresh h1)" = 200 ] || fail "second grant refresh"
jq -r .refresh_token "$S/oc-tok.out" | tr -d '\n' >"$S/oc-h2-rt"
echo "waiting 31 s for the grace window to close"
sleep 31
[ "$(refresh h1)" = 400 ] && [ "$(tok_error)" = invalid_grant ] || fail "a reuse after 31 s was not invalid_grant"
[ "$(tok grant_type=refresh_token "client_id=$CID" "refresh_token=$(cat "$S/oc-h2-rt")")" = 400 ] &&
  [ "$(tok_error)" = invalid_grant ] || fail "the live token survived a reuse after 31 s"
pass "a reuse 31 s after the rotation is invalid_grant and revokes the whole grant"

# 11. A disabled member, a tampered token, and the API key path.
grant_code d1
[ "$(redeem d1)" = 200 ] || fail "third grant"
keep d1
[ "$(probe oc-d1-at)" = 200 ] || fail "the third grant's token was refused"
# Change the first character of the signature, so the signature check is what refuses it.
jwt=$(cat "$S/oc-d1-at")
sig=${jwt##*.}
case "$sig" in A*) sig="B${sig:1}" ;; *) sig="A${sig:1}" ;; esac
printf '%s.%s' "${jwt%.*}" "$sig" >"$S/oc-tampered"
unset jwt sig
bearer oc-tampered
[ "$(probe oc-tampered)" = 401 ] || fail "a tampered token was accepted"
r=$(req oc-admin.jar POST /api/keys "{\"name\":\"$run-key\"}")
key_id=$(body "$r" | jq -r .key.id)
save_key "$(body "$r")" oc-key
[ "$(probe oc-key)" = 200 ] || fail "an API key stopped working"
pass "a tampered token is 401, and an API key still works"

[ "$(refresh d1)" = 200 ] || fail "refresh before the disable"
jq -r .refresh_token "$S/oc-tok.out" | tr -d '\n' >"$S/oc-d2-rt"
t0=$(date +%s%N)
[ "$(code "$(req oc-admin.jar PATCH "/api/users/$member_id" '{"status":"disabled"}')")" = 200 ] || fail "disable member"
until [ "$(probe oc-d1-at)" = 401 ]; do
  [ "$(ms_since "$t0")" -lt 1000 ] || fail "a disabled member's access token is still accepted after 1 s"
  sleep 0.05
done
case "$(hdr "$S/oc-probe.hdr" www-authenticate)" in *'error="invalid_token"'*) ;; *) fail "the 401 has no error=invalid_token" ;; esac
[ "$(tok grant_type=refresh_token "client_id=$CID" "refresh_token=$(cat "$S/oc-d2-rt")")" = 400 ] &&
  [ "$(tok_error)" = invalid_grant ] || fail "a disabled member's refresh token still works"
pass "after the member is disabled the access token gets 401 invalid_token ($(ms_since "$t0") ms) and the refresh token is invalid_grant"

# 12. Secrets in the logs. The values are matched with grep -F -f; only a count is printed.
: >"$S/oc-secrets.txt"
for f in "$S"/oc-*.code "$S"/oc-*.verifier "$S"/oc-*-at "$S"/oc-*-rt; do
  if [ -s "$f" ]; then
    cat "$f" >>"$S/oc-secrets.txt"
    echo >>"$S/oc-secrets.txt"
  fi
done
{
  echo "$CSRF"
  awk '$6 == "sid" { print $7 }' "$S/oc-member.jar" "$S/oc-admin.jar"
  printf '%s\n' urt_ code_verifier eyJhbGciOiJFZERTQSI
} >>"$S/oc-secrets.txt"
# Both services log the request URL, so a canary in a URL proves the grep below can see a leak.
canary=oc$(rand_url 9)
curl -s -o /dev/null "$APP/api/config?c=$canary"
curl -s -o /dev/null -X POST "$MCP?c=$canary" -H 'content-type: application/json' --data-binary '{}'
sleep 1
for svc in control-plane gateway; do
  kubectl -n platform logs -l "app.kubernetes.io/name=$svc" -c "$svc" --tail=-1 --since-time="$start_ts" >"$S/oc-$svc.log"
  [ -s "$S/oc-$svc.log" ] || fail "no $svc log lines since the start, so nothing was checked"
  [ "$(grep -c -F -- "$canary" "$S/oc-$svc.log" || true)" -ge 1 ] || fail "the $svc log check cannot see a known string, so it proves nothing"
  n=$(grep -c -F -f "$S/oc-secrets.txt" "$S/oc-$svc.log" || true)
  [ "$n" = 0 ] || fail "$n $svc log line(s) hold a code, verifier, token, cookie or CSRF value"
done
pass "no code, verifier, token, cookie or CSRF value in the control-plane and gateway logs since the start ($(grep -c . "$S/oc-secrets.txt") values and patterns checked, a canary URL was found in both)"

# 13. A fresh registration for the browser check. The verifier is thrown away; the URL has no secret.
[ "$(register "{\"client_name\":\"oauth-check browser\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\"}")" = 201 ] ||
  fail "registration for the browser check"
BCID=$(jq -r .client_id "$S/oc-b")
bch=$(rand_url 32 | openssl dgst -sha256 -binary | base64 -w0 | tr '+/' '-_' | tr -d '=')
echo "Browser check URL (a fresh client, no token in it):"
echo "$APP/oauth/authorize?response_type=code&client_id=$BCID&redirect_uri=$REDIRECT_ENC&code_challenge=$bch&code_challenge_method=S256&scope=mcp%3Atools&resource=$RES_ENC&state=browser-check"
echo OK
