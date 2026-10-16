# Shared helpers for the live check scripts. Callers set S, APP and MCP before sourcing.
# Secrets go to files under $S (mode 600) and are never printed.

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }
ms_since() { echo $((($(date +%s%N) - $1) / 1000000)); }
# under SECONDS MAX: true when a curl time_total is below MAX seconds.
under() { awk -v t="$1" -v max="$2" 'BEGIN { exit !(t < max) }'; }

# A run whose APP points at one cluster while kubectl points at another would test the wrong thing
# or, worse, change it. nip.io URLs need the k3d context; any other APP needs the VM context.
# EXPECT_CONTEXT overrides both.
expect_kube_context() {
  local want have
  if [ -n "${EXPECT_CONTEXT:-}" ]; then
    want=$EXPECT_CONTEXT
  elif [[ "$APP" == *nip.io* ]]; then
    want=k3d-${CLUSTER:-urumi}
  else
    want=urumi-vm
  fi
  have=$(kubectl config current-context 2>/dev/null) || have=''
  [ "$have" = "$want" ] ||
    fail "APP is $APP, so kubectl must use context $want, but it uses '${have:-none}': kubectl config use-context $want"
}
expect_kube_context

# req JAR METHOD PATH [JSON]: the body, then the status code on its own last line.
req() {
  local args=(-s -b "$S/$1" -c "$S/$1" -H "origin: $APP" -X "$2" -w '\n%{http_code}')
  if [ $# -ge 4 ]; then args+=(-H 'content-type: application/json' --data-binary "$4"); fi
  curl "${args[@]}" "$APP$3"
}
body() { sed '$d' <<<"$1"; }
code() { tail -n1 <<<"$1"; }

# admin_login JAR: the password goes from the Secret into a body file, never into argv or stdout.
admin_login() {
  local r
  kubectl -n platform get secret platform-bootstrap -o json |
    jq '{email: (.data.ADMIN_EMAIL | @base64d), password: (.data.ADMIN_PASSWORD | @base64d)}' >"$S/admin-login.json"
  r=$(curl -s -c "$S/$1" -H "origin: $APP" -H 'content-type: application/json' \
    --data-binary @"$S/admin-login.json" -w '\n%{http_code}' "$APP/api/auth/login")
  rm -f "$S/admin-login.json"
  [ "$(code "$r")" = 200 ] || fail "admin login gave $(code "$r")"
}

# save_key RESPONSE NAME: the bare key goes to $S/NAME and a curl header file to $S/NAME.hdr.
# printf is a builtin, so the key never shows up in a process list here.
save_key() {
  jq -r '.secret' <<<"$1" >"$S/$2"
  printf 'authorization: Bearer %s\n' "$(cat "$S/$2")" >"$S/$2.hdr"
}

# rpc KEY JSON: one raw JSON-RPC POST to the gateway. Prints the JSON-RPC response, then curl's
# time_total in seconds on its own last line. The gateway answers as JSON or as one SSE frame.
rpc() {
  local out b
  out=$(curl -s -X POST "$MCP" -H @"$S/$1.hdr" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' \
    --data-binary "$2" -w '\n%{time_total}')
  b=$(sed '$d' <<<"$out")
  if grep -q '^data: ' <<<"$b"; then b=$(sed -n 's/^data: //p' <<<"$b"); fi
  printf '%s\n%s\n' "$b" "$(tail -n1 <<<"$out")"
}

# chat_rate_limited SSE: true when an agent turn ended in an error because no LLM provider would
# answer. Any other error is a real failure.
chat_rate_limited() {
  local err
  err=$(grep -A1 '^event: error$' <<<"$1" || true)
  grep -q 'rate limited' <<<"$err"
}
