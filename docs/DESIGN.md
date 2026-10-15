# Design notes

Engineer's notes on choices the SPEC leaves open or explains only in a line. This file has the M11 and M12 sections so far. The earlier milestones are listed in `.notes/HANDOFF.md` as still to be written here.

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

### Tool definitions of a hosted server are reviewed after the first sync

`upsertTools` in `apps/gateway/src/registry-db.ts` approves the tools of a hosted server only when the server has no tool rows yet, which is its first sync. Creating the server is the admin's review of that image. Any later sync follows the external rules: a changed definition or a new tool is `changed` and hidden until it is approved in Tool approvals. Store and system servers stay auto-approved. The approvals list and the approve call in `apps/control-plane/src/api-approvals.ts` accept `hosted` as well as `external`. Tests: four `hosted` cases in `sync.test.ts` and two in `api-approvals.test.ts`. See the threat model, section 11, gap 3.

## Rate limits (SPEC 19)

- Subject and window. `key:<api_key_id>` for an API key, `user:<user_id>` for the agent. One upsert per counted call on `rate_counters`, with the window start taken from Postgres time (`date_trunc('minute', now())`), never from the replica clock. The count and the seconds left in the window come back from the same statement, so two replicas cannot disagree. The limit is the key's `rate_limit_per_min` when set (admin only, 1 to 10000), else `gateway.rateLimitPerMinute` (60 in the chart, 120 in `values-local.yaml`).
- Fixed windows. A client can send up to twice the limit across a window boundary (N calls at :59, N more at :00). Accepted: one upsert per call is the whole cost, and a sliding window would need a read and a write.
- What counts. Every `tools/call` that gets past SPEC 6.5 step 1: a direct call, the inner call of `call_tool` (once), and a valid `search_tools`. `tools/list` is never limited. An unknown or hidden name is answered at step 1, before the limit, so it is not counted. It is still audited, and it costs the caller nothing but one audit row. Counting it would let a client burn its quota on names, and would make a hidden tool look different from a missing one.
- Refusal. A tool result with `isError: true` and `Rate limit exceeded, retry in <n> s`, audit outcome `rate_limited`. Refused calls still count, so a client that keeps hammering stays blocked until the window ends. A rate-limited call to a disabled server says rate limited (step 2 comes before step 3).
- Fails open. A counter query that errors or takes more than 2 s lets the call through and logs one `warn` with the error code. See the threat model, section 12.
- Cleanup. The replica that holds lock 4242 (the status writer) deletes windows older than 2 minutes once a minute.
- Race. `apps/gateway/src/rate-limit.test.ts` sends 50 parallel hits against a limit of 20 and checks that exactly 20 are allowed. `replica-demo.sh` and the limit-5 check in M12 Task 15 prove the same across two pods.

## Observability (SPEC 20)

- Metrics text. `packages/core/src/metrics.ts` writes the Prometheus text format (counter, gauge read at scrape time, histogram with `le`, label escaping, a cap of 1000 series per metric as a backstop). Decision E2: no `prom-client`, so no new npm dependency and no default process metrics. The HPA reads CPU from metrics-server, not from Prometheus.
- Gateway metrics, on the health port 9090: `gateway_tool_calls_total{server,outcome}`, `gateway_tool_call_duration_seconds{server}`, `gateway_upstream_up{server}`, `gateway_tools_exposed{server}`. The counter and the histogram are fed from the finished audit row in `writeAudit`, so metrics and the audit log cannot disagree. The gauges are read from `Registry.serverStats()` at scrape time and describe this replica only; Prometheus keeps replicas apart by `instance`.
- The bounded label rule. A label value is a server slug from the registry, one of the fixed words `_search` and `_unknown`, or an audit outcome. Text the client sent never becomes a label, so a client cannot create series by inventing tool names. The same mapping (`serverLabel`) names the server in the call log line. The histogram observes only `ok`, `tool_error`, `timeout`, `unreachable` and `upstream_error`, the outcomes where the call reached or tried the upstream.
- Control-plane metrics, on the internal port 3001: `provisioner_stores{status}` (all four statuses, read from `stores` at scrape time; the rows are left out when the query fails) and `provisioner_duration_seconds` (creation to ready, observed when the reconcile pass marks a store ready; it starts again at zero on a restart). Neither `/metrics` is routed by an Ingress. The public control-plane port has no `/metrics`.
- Health page. `GET /api/stats/servers?window=<n>m` (1 to 1440, default 60) reads `audit_events` and `mcp_server_status`, so the page works without Prometheus. Per server: calls, calls per minute, counts per outcome, error rate and p50 and p95. The error rate is (attempted - ok) / attempted, where attempted is the same five outcomes as the histogram. A denied, rate limited, disabled or bad request never waited on the server, so it says nothing about the server's health. `percentile_cont` runs over attempted calls only. Rows with an empty slug (`search_tools`) belong to no server and are skipped. A server with no calls is listed with zero calls and null rates. Every role may read it (see the threat model, section 13). The Health pill reuses `serverPill`, so it matches the Servers page, which is why the response carries `approval` too.
- Request ids. Gateway, control-plane and agent use `requestIdOptions` from `@woo/core`: a UUID made by the server, logged as `request_id`. A client `x-request-id` or `request-id` header is never read. The gateway sets `x-request-id` on every response, and the audit row of that request carries the same id (stateless mode puts one JSON-RPC message in each POST).
- Trace context. The gateway takes `params._meta.traceparent` if it is valid, else the HTTP `traceparent` header if valid, else it starts a new trace. Valid means version `00`, a lowercase 32 hex trace id and a 16 hex parent id, neither all zero, and 2 hex flags, nothing more. Each upstream call gets the same trace id and flags with a new parent id, sent as `_meta.traceparent`. `tracestate` and every other client `_meta` key are never forwarded, because client data must not reach an upstream. Health-check calls carry no trace. The agent starts one trace per chat turn and every gateway call of the turn sends it. fx-mcp and woo-mcp log `tool`, `trace_id` and `ms` per call through `logToolCalls`, never arguments, results or error text. One grep for a trace id follows a chat turn through the agent, the gateway and the upstream.
- Call log line. One info line per `tools/call` in the gateway: `request_id`, `trace_id`, `user_id`, `server`, `tool`, `outcome`, `ms`. A name the registry did not resolve is logged as `_unknown`, not echoed.
- Prometheus (`monitoring.enabled`, off by default). One Deployment, image `prom/prometheus:v3.15.0`, uid 65534 (the image's own user), read-only root, emptyDir for the data (24 h or 512MB), no ServiceAccount token, no Service and no Ingress: reach it with `kubectl port-forward`. It finds gateway pods through DNS on the headless Service `gateway-metrics`, so it needs no Kubernetes API access and no RBAC. The control-plane is a static target. Three rows join the SPEC 16 matrix: Prometheus egress to gateway pods on 9090 and to the control-plane on 3001 (DNS from `allow-dns`), gateway ingress on 9090 from Prometheus, control-plane ingress on 3001 from Prometheus. `netpol-check.sh platform` proves them when Prometheus is up.

## Scaling (SPEC 23)

- Why more than one gateway replica works. Nothing in a gateway holds state a second replica needs. API keys are looked up in Postgres and cached for 10 s, and a revoke or a role change reaches every replica through NOTIFY. Rate limits use `rate_counters` (above). The registry loads from Postgres and reloads on NOTIFY. Upstream health is checked by every replica for its own view, and the replica holding lock 4242 writes the status rows. MCP is stateless (one POST, one answer), so any replica can answer any call. `X-Gateway-Replica` names the answering pod.
- Stop. A pod that gets SIGTERM can still receive calls that Traefik routed a moment earlier. The gateway has `preStop: sleep 5`, which keeps it listening while Traefik and the EndpointSlice drop it, then SIGTERM and a drain of at most 5 s. `terminationGracePeriodSeconds` is 15 for the gateway (10 for the other Node services). `lifecycle.preStop.sleep` needs Kubernetes 1.30 or later.
- PodDisruptionBudget. `minAvailable: 1`. The chart refuses to render it for one replica without the HPA, because it would block every node drain.
- HPA (`gateway.hpa.enabled`). `autoscaling/v2`, CPU 70% of the 50m request, 2 to 4 replicas. With the HPA on, the Deployment leaves out `replicas`, so a Helm upgrade does not reset what the HPA chose. The cost of that rule: switching an existing release from a fixed count to the HPA drops the Deployment to one replica until the HPA acts (seen on k3d in M12 Task 15: 2 pods, then 1, then 2 again within a minute). In production turn the HPA on from the first deploy with `minReplicas` of 2 or more.
- Postgres connections. Each replica holds a pool of up to 5 plus two dedicated connections (the NOTIFY listener and the status lock). Four replicas use 4 x 7 + 6 for the control-plane = 34 of the 100 allowed. With two replicas and the demo running, `pg_stat_activity` showed 14.
- Proof, on k3d, with `--set gateway.replicas=2 --set gateway.pdb.enabled=true`. `scripts/replica-demo.sh` sends 20 calls through the Ingress and deletes a pod after call 8. Three runs, each 20 of 20 ok, with two pod names before the delete. Evicting one gateway pod answered 201 and evicting the second right after answered 429 (TooManyRequests, the disruption budget). A key with limit 5 got 5 ok and 2 rate limited across both replicas. e2e, chat-check and obs-check ended OK with two replicas. The HPA showed `cpu: 24%/70%` with 2 replicas.

## fx-mcp serves cached rates during an outage (SPEC 11)

- When. Only for outage errors: a network error or the 10 s timeout (`fx_unreachable`), any 5xx and 429. Any other 4xx is a real answer (bad date, unknown currency) and stays an error.
- How. After an outage error fx-mcp does not call Frankfurter for 60 s (`STALE_COOLDOWN_MS`) and answers from the cache at once, so an outage costs one 10 s wait per minute, not one per call. The cache keeps at most 256 entries (`MAX_CACHE_ENTRIES`) and drops the oldest fetch first. Entries stay after the 1 hour TTL so they can serve stale.
- What it can answer (decision B1). The exact cached query first; else a rate derived from the newest cached full EUR table (rate = rates[to] / rates[from], EUR = 1). fx-mcp loads that table and `/currencies` once in the background after it listens. A failure there is logged and readiness does not change (readiness never checks a dependency). Dated queries need their own cached entry.
- The age is always stated. Every rates answer has `stale`, `cache_age_seconds` and the rates' own `date` in `structuredContent`. A stale text starts with `Cached rates from <date>, fetched <age> ago (Frankfurter is unreachable): `. With nothing cached that can answer, the error stays `fx_unreachable` ("Frankfurter is unreachable and no cached rates exist"). The tool descriptions gained one sentence about this, which changed the fx definition hashes once; `fx` is a system server, so it was auto-approved.

## hosted-check.sh without the internet

- The rule (decision 28). A tool call passes when the gateway reached the server and the server answered: the newest audit row for that exposed name (read through `GET /api/audit?server=<slug>`) has outcome `ok` or `tool_error`. `unreachable`, `timeout`, `upstream_error`, `disabled`, `denied` and `bad_request` fail. The PASS line says `answered ok` or `answered with a tool error`. This proves the platform path (gateway, NetworkPolicy, hosted pod) and not the rates API. Public 443 egress is proven by `netpol-check.sh hosted` alone, which needs the internet by design and prints `SKIP` when this machine cannot reach the test URL.
- `hosted-check.sh offline <slug>`. Creates the server with `FX_BASE_URL=https://192.0.2.1/v1` (TEST-NET-1, never routed), so every fetch hits fx-mcp's 10 s timeout inside the gateway's 15 s. It expects `tool_error` with `fx_unreachable`, then deletes the server. That proves the rule live without cutting the laptop's network.
- `e2e.sh` uses the same rule after it restarts fx-mcp (decision D1).

## The first sync is a flag, not a count

`mcp_servers.tools_synced_at` (migration `0002`) is set by the first successful tool list, even an empty one. For a hosted server, `upsertTools` runs `update mcp_servers set tools_synced_at = now() where id = $1 and tools_synced_at is null returning id` inside its transaction and approves only when that returns a row. The row lock makes two replicas agree: exactly one approves, the other sees the flag after the first commits. Before this, a hosted server whose first list was empty got its later tools approved as a first sync. `persistTools` now writes on the first list even when it is empty. The migration backfills `now()` for every server that has at least one tool row. Store and system servers set the flag as well, so the column means the same for every kind. Because of the migration, the control-plane must ship before the gateway; gateway readiness waits for every journal entry.
