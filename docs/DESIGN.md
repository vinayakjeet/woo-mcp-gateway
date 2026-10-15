# Design notes

Engineer's notes on choices the SPEC leaves open or explains only in a line. This file has the M11 sections so far. The earlier milestones are listed in `.notes/HANDOFF.md` as still to be written here.

## Tool search mode (SPEC 17)

### Why it exists

A model that sees every tool of every server pays for it twice: the definitions fill the prompt, and it picks the wrong tool more often as the list grows.

- RAG-MCP (arXiv 2505.03275) retrieves the relevant tools first. It raised selection accuracy from 13.62% to 43.13% and cut prompt tokens by more than half.
- Anthropic's tool search documentation says selection quality degrades once a model sees more than 30 to 50 tools.

### Why 40

`SEARCH_THRESHOLD = 40` in `apps/gateway/src/search.ts`. It sits inside the 30 to 50 range, above the 19 tools the demo has (so the default experience is unchanged) and below the point where the documentation reports trouble. The rule is "more than 40 visible tools", so 40 stays in full mode and 41 switches. Visible means after the principal's policy rules (SPEC 6.4), so a member with narrow rules keeps the full list longer than an admin.

### Which mode a request gets

1. `?toolMode=search|full` on the URL wins. Any other value is HTTP 400 with JSON-RPC -32602, answered before the SDK runs.
2. Otherwise the key's `tool_mode` (`full`, `search`, `auto`; set at key creation).
3. `auto` means search above 40 visible tools. Principals without a key (the agent, later OAuth) are `auto`.

The agent has `AGENT_TOOL_MODE` (chart value `agent.toolMode`) to force a mode, which is how the 19-tool demo shows search in Chat.

### What the model sees

In search mode `tools/list` returns two tools:

- `search_tools {query, limit}`: `query` is 1 to 200 characters, `limit` is 1 to 10 (default 5). It returns `{tools: [{name, description, inputSchema}]}` as `structuredContent` and as one text block with the same JSON, because many clients pass only the text on. No match is an empty list.
- `call_tool {name, arguments}`: runs one tool by its exposed name.

The meta-tools are callable in every mode. Only the list changes. Direct calls by exposed name also still work in search mode. Reason: under `auto`, a client that listed in search mode must keep working if the count drops to 40 before its next call.

### Ranking

BM25 through minisearch 7.2.0, built per request from the principal's visible tools (nothing is cached, so nothing can go stale or leak between roles). Fields: exposed name (boost 2), description, and the top-level parameter names and descriptions. Options: `prefix: true`, `fuzzy: 0.2`. Ties sort by exposed name so results are stable.

Measured on 2026-10-15 (Node 24, this laptop, 30 runs after a warm-up, the query `widgets gadgets 123`):

| Tools | Median  | Worst   |
| ----- | ------- | ------- |
| 19    | 0.38 ms | 1.75 ms |
| 100   | 0.81 ms | 1.49 ms |
| 500   | 3.57 ms | 5.28 ms |

`search.test.ts` fails if 500 tools take 50 ms or more, so a per-request index is within budget with a wide margin. Caching the index per registry generation is on the nice-to-have list, not needed.

### Why `call_tool` shares the direct call path

`call_tool` calls the same internal function as a direct `tools/call`. Policy, the enabled check, the approval state, the bulkhead, the breaker, the timeout and the audit row all live in that function, so a second copy cannot drift. A hidden tool gets the byte-identical "Unknown tool" error and a `denied` audit outcome. `search_tools` and `call_tool` as the inner name are unknown names, so there is no recursion. `search_tools` never returns a tool the principal could not list: it searches the already filtered list.

### Audit shape (SPEC 9)

One row per `tools/call`, so `search_tools` gets one too.

| Call           | `server_slug` | `tool_name`, `exposed_name` | `meta_tool`    |
| -------------- | ------------- | --------------------------- | -------------- |
| `search_tools` | empty         | `search_tools`              | `search_tools` |
| `call_tool`    | the real one  | the real tool               | `call_tool`    |
| direct call    | the real one  | the real tool               | null           |

`search_tools` rows have `server_id` null and an empty slug, so M12's Health page must skip them. The query text is never stored, only `args_sha256`.

## Hosted servers (SPEC 21)

### Flow

1. An admin posts slug, image, port, path, env, secret env, CPU and memory to `POST /api/hosted`.
2. The API validates (see below), generates a 32-byte token, and in one transaction inserts the `mcp_servers` row (kind `hosted`, managed, disabled, bearer auth with the token) and the `hosted_servers` row (status `pending`). It sends `NOTIFY hosted_changed`.
3. The control-plane leader (advisory lock 4243) runs a hosted pass on every tick and on that notification. It decrypts the secret env, builds four objects and applies them server-side with field manager `platform`, in the order Secret, NetworkPolicy, Service, Deployment, so the policy exists before the pod starts.
4. The pass follows the Deployment. At `availableReplicas >= 1` the status becomes `ready` and the server row is enabled. The gateway needs no hosted-specific code: a hosted row is a managed upstream, with no SSRF pinning and tools approved as they are.
5. `DELETE` sets `deleting`, deletes the server row (the tools leave `tools/list` at once) and notifies. The pass deletes every object carrying `urumi.io/hosted=<slug>`, one object at a time, then removes the hosted row. Audit rows stay.

### The four objects

All carry `urumi.io/hosted=<slug>` and `app.kubernetes.io/managed-by: control-plane`.

- Secret `<slug>-env`: the secret env plus `MCP_SHARED_TOKEN`. Applied as `data` (base64), never `stringData`.
- NetworkPolicy `<slug>`: ingress only from the gateway pods on the server port; egress only TCP 443 to `0.0.0.0/0` except the five SPEC 16 private ranges. DNS comes from the namespace's `allow-dns`. The gateway's namespace and labels reach the control-plane as `HOSTED_GATEWAY_NAMESPACE` and `HOSTED_GATEWAY_LABELS`, rendered from the same helper the gateway pod uses.
- Service `<slug>` on the server port.
- Deployment `<slug>`: one replica, `runAsNonRoot` with uid and gid 10001, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, read-only root with a 64Mi `/tmp` emptyDir, no ServiceAccount token, no service links, `terminationGracePeriodSeconds: 10`, `progressDeadlineSeconds: 300`. Requests are fixed at 20m and 64Mi (lowered to the limit if the limit is smaller). Limits come from the form, capped by `hosted.maxCpu` (500m) and `hosted.maxMemory` (256Mi).

### Status rules

- `pending`: the reason is the first pod waiting reason (`ImagePullBackOff`, `CrashLoopBackOff`, `CreateContainerConfigError`) or the status word of a failed apply.
- `ready`: `availableReplicas >= 1`.
- `failed`: `Progressing=False` with `ProgressDeadlineExceeded`, or an apply answered 400 or 422 (a retry cannot fix those). A failed server can only be deleted.
- `deleting`.

Status follows readiness both ways. A ready server whose pod dies goes back to `pending` with the reason; its server row stays enabled and the gateway's health check marks it unreachable. A Deployment deleted behind the control-plane's back is created again on the next tick.

Every change sends `NOTIFY hosted_changed`. `PATCH enabled: true` on a hosted row answers 409 `hosted_not_ready` until the hosted row is `ready`, so only the reconcile pass enables it.

### Probes

Readiness and liveness are `tcpSocket` on the MCP port (readiness: first check after 1 s, every 5 s; liveness: after 10 s, every 20 s; three failures either way). An HTTP probe on the MCP path would need the bearer token and a POST, and an image may not serve `/healthz`. A TCP probe says the process listens, not that it answers well. The gateway's health check covers the rest.

### The generated token (decision C1)

The form has no auth fields. The control-plane generates the token, injects it as `MCP_SHARED_TOKEN` and registers the server row with bearer auth and the same token encrypted under the slug as AAD. `fx-mcp` refuses to start without that variable. An image that ignores it still works because the NetworkPolicy admits only the gateway. The name is reserved in the form.

### Secrets at rest

Secret env is one JSON object encrypted with `encryptSecret`, AAD `hosted:<slug>`, so a ciphertext cannot be moved to `mcp_servers.auth_secret_enc` of the same slug. The control-plane decrypts it only inside the reconcile pass. No API response, log line, error, `status_reason`, audit row or page shows a value; `hosted-check.sh` greps the GET response and the control-plane log for the demo secret and the generated token.

### Teardown never sleeps

The plan had the pass wait up to 120 s for pods to stop. It runs inside the provisioner tick, so a wait would hold up store installs. Teardown deletes by label, lists pods once and returns with the reason "Waiting for pods to stop". The next 5 s tick looks again.

### Restart proof

State lives only in Postgres and in labeled objects, so a new leader needs nothing from the old one. `kubectl rollout restart` cannot prove this: the old pod keeps working until the new one is Ready (about 10 s), and it finished both a create (9 s) and a delete (1 s) first. The proof is a crash, `kubectl delete pod <control-plane> --grace-period=0 --force`, run on 2026-10-15:

- Mid-create. Killed once the Deployment existed and was not yet available. The database showed `pending`, reason "Waiting for the Deployment", server row disabled. The new pod was elected, the row became `ready` and the server row enabled (ready after 18 s, against 8 to 11 s uninterrupted). End state: one Deployment, Service, NetworkPolicy, Secret, ReplicaSet and Pod; Deployment generation 1, so nothing was applied twice; one server row.
- Mid-delete. Killed right after the 202. The old pod had already deleted the Deployment and its pod, and had left the Service, NetworkPolicy and Secret. The row was `deleting` and the server row was gone. The new leader removed the rest as soon as it was elected. End state: no object labeled `urumi.io/hosted=fx2`, no hosted row, no `fx2` server row, and only `allow-dns` and `default-deny` left in `mcp-hosted`.

### Tool definitions of a hosted server are not reviewed

`upsertTools` in `apps/gateway/src/registry-db.ts` treats every kind except `external` as managed: on each sync it overwrites `approved_hash` and `approved_definition` and keeps the tool `active`. A hosted server whose image tag is replaced with an image that has different tools (or different descriptions) shows the new tools to every client with no pass through Tool approvals. SPEC 22.7 and M10 decision 15 chose this because the platform created the server. The test that pins it is `store tools are approved on every change and stay active` in `sync.test.ts`; no test names the `hosted` kind. See the threat model, section 11, for what this means with re-pushable tags.
