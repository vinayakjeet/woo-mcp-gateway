# Sourced by the live check scripts. Stops a run whose target and kubectl context disagree: it
# would test the wrong cluster or, worse, change it. Does not depend on the caller's helpers.
#   EXPECT_CONTEXT=<name>   the context this run needs (wins over everything)
#   APP                     a nip.io URL means the k3d context, any other URL means urumi-vm
# Scripts without an APP (netpol-check.sh, vap-check.sh) run on k3d unless EXPECT_CONTEXT is set.
expect_kube_context() {
  local want have
  if [ -n "${EXPECT_CONTEXT:-}" ]; then
    want=$EXPECT_CONTEXT
  elif [ -n "${APP:-}" ] && [[ "$APP" != *nip.io* ]]; then
    want=urumi-vm
  else
    want=k3d-${CLUSTER:-urumi}
  fi
  have=$(kubectl config current-context 2>/dev/null) || have=''
  if [ "$have" != "$want" ]; then
    echo "FAIL: this run needs kubectl context $want, but it uses '${have:-none}': kubectl config use-context $want (or set EXPECT_CONTEXT)" >&2
    exit 1
  fi
}
expect_kube_context
