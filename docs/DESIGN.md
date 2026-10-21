# Design notes

Engineer's notes on how the system fits together, and on choices the SPEC leaves open or explains in a line. The first part is the overview: components, the path of a tool call, failure handling, the chat agent, stores, and what changes between local and production. The sections after it explain single features.

## System overview

### Components

| Component                | Namespace      | Kind                                       | Port                              | What it does                                                                                                                                      | Talks to                                    |
| ------------------------ | -------------- | ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| web                      | platform       | Deployment                                 | 8080                              | Static React dashboard                                                                                                                            | nothing                                     |
| control-plane            | platform       | Deployment, 1 replica                      | 3000 public, 3001 internal        | Login, users, invites, keys, server CRUD, approvals, policies, audit queries, stats, stores and the provisioner, hosted servers, the OAuth server | Postgres, Kubernetes API, helm CLI          |
| gateway                  | platform       | Deployment, 1 replica locally, 2 on the VM | 8080 MCP, 9090 health and metrics | The one MCP endpoint: auth, policy, aggregation, routing, rate limits, audit writes, upstream health checks                                       | Postgres, upstream servers                  |
| agent                    | platform       | Deployment                                 | 3100                              | Chat endpoint (SSE) and the LLM tool loop                                                                                                         | gateway, control-plane 3001, LLM API on 443 |
| postgres                 | platform       | StatefulSet and PVC                        | 5432                              | Platform state                                                                                                                                    | nothing                                     |
| fx-mcp                   | platform       | Deployment                                 | 8080                              | Currency tools, a second upstream                                                                                                                 | Frankfurter API on 443                      |
| prometheus               | platform       | Deployment, only if `monitoring.enabled`   | 9090                              | Scrapes gateway and control-plane metrics                                                                                                         | those two                                   |
| mariadb, wordpress       | store-`<slug>` | StatefulSet and Deployment, PVCs           | 3306, 80                          | One store: database, storefront, wp-admin, WooCommerce REST API                                                                                   | each other                                  |
| woo-mcp                  | store-`<slug>` | Deployment                                 | 8080                              | MCP server for that store                                                                                                                         | wordpress in its own namespace              |
| store-bootstrap, wp-cron | store-`<slug>` | Job (Helm hook), CronJob                   | none                              | Install WordPress and WooCommerce and create the REST key; run WordPress cron                                                                     | mariadb                                     |
| hosted servers           | mcp-hosted     | One Deployment each                        | admin's choice                    | A container image an admin registered                                                                                                             | public port 443 only                        |

Other namespaces: `kube-system` (Traefik), and `cert-manager` on the VM.

Only the gateway talks to upstream MCP servers, health checks included. The control-plane never calls one. It writes rows to Postgres and sends `NOTIFY`, and every gateway replica loads the change. Postgres is the only link between the two, so a gateway replica can start, die or be added without the control-plane knowing.

Jobs and the CronJob have no probes (SPEC 15 gives them none). They run once and exit, so there is nothing for a readiness or liveness probe to check. Helm waits for the bootstrap hook to finish, and `kubectl -n store-<slug> get cronjob wp-cron` shows `lastSuccessfulTime`. Every long-running container in a Deployment or StatefulSet has requests, limits, and readiness and liveness probes (init containers have limits only).

### What is public

Three hosts go through Traefik: `app.<domain>` (web at `/`, control-plane at `/api` and `/oauth`, agent at `/api/chat`), `mcp.<domain>` (gateway at `/mcp` and the protected resource metadata) and `<slug>.shop.<domain>` (the storefront and wp-admin of one store). Everything else is a ClusterIP Service with no Ingress: Postgres, woo-mcp, fx-mcp, hosted servers, the gateway health port 9090 and the control-plane internal port 3001.

"Internal only" is enforced by NetworkPolicies, not by the lack of an Ingress: the `platform`, `mcp-hosted` and store namespaces are default deny, and woo-mcp accepts only gateway pods (`scripts/netpol-check.sh main`, and `platform` for the rest). The rules and their proofs are in `docs/THREAT_MODEL.md`, sections 2 to 5.

### Where state lives

- Postgres holds users, hashed API keys, servers with encrypted credentials, tools and their definition hashes, policies, the audit log, rate counters, stores and the OAuth tables. A store's own data is in its MariaDB and WordPress volumes.
- A gateway replica keeps its tool map and its upstream connections in memory and rebuilds them from Postgres. It stays current through `LISTEN`: `registry_changed`, `policies_changed`, `key_revoked`, `status_changed` and `tools_changed`. Notifications sent while the connection was down are gone, so after a reconnect the replica reloads everything and drops its key cache (`apps/gateway/src/sync.ts`, `relisten`).
- The gateway keeps no MCP sessions. Any replica can serve any request, which is why a pod can be killed mid-demo (`scripts/replica-demo.sh`, 20 of 20 calls ok). The cost: a legacy client has no push channel and sees list changes only when it lists again.

### The path of a tool call

1. The client sends `POST /mcp` to `mcp.<domain>` with an API key or an OAuth token. Traefik ends TLS (production) and forwards to a gateway pod on 8080.
2. The gateway checks `Origin`, then authenticates in order: API key (prefix lookup, HMAC compare, not revoked, user active), agent JWT, OAuth access token. The result is a principal: user, role, and how they came in (`api_key`, `agent`, `oauth`).
3. `tools/list` is answered from memory: servers that are enabled, connected and approved, tools that are active, filtered by the role's policy, named `<slug>__<tool>` and sorted. It never waits on an upstream.
4. `tools/call` resolves the exposed name. An unknown name and a name hidden by policy get the same JSON-RPC error (-32602), so a member cannot tell a hidden tool from a missing one. Then, in order: rate limit, server state, the circuit breaker, the bulkhead, and the call with a timeout.
5. The gateway calls the upstream over Streamable HTTP with the credential the admin stored for it, and a new `traceparent` child id. For a store that is woo-mcp in `store-<slug>`, with that store's bearer token.
6. woo-mcp calls the WooCommerce REST API v3 in the same namespace, signing each request with OAuth 1.0a (the README explains why). It returns a one-line summary plus `structuredContent` with only the fields it chose to expose.
7. The result goes back unchanged. An audit row is written in a `finally` block: user, key, how they authenticated, server, tool, outcome, duration, replica and a hash of the arguments. The same row is written for refusals and failures.

The chat agent takes the same path from step 2, with an agent JWT instead of a key. Names and collisions are in "Naming and collisions" below.

### Failure handling

Each rule below says what happens and what pins it.

- A slow upstream. Every call has a deadline, `timeout_ms` per server (15 s by default). On expiry the member gets a tool error, "Server `<slug>` did not answer within 15 s", audited as `timeout`. Listing is unaffected because it reads memory. Proof: `isolation.test.ts` ("lists both servers from memory in under 300 ms while a call hangs", "fails the silent call with the configured timeout error", "keeps the fast server answering while the silent one hangs").
- A dead upstream. Each replica checks every upstream every 10 s with a `tools/list` that has a 3 s timeout. Three failures in a row turn it unreachable, so the worst case is about 30 s. A call that is refused or cannot resolve the name skips the count and marks it unreachable at once; a connection reset triggers an immediate check instead, because one dropped pooled connection is not a dead server. An unreachable server contributes no tools, calls to it answer at once with the failure kind (`dns`, `refused`, `timeout`, `tls`, `http_401`, `http_5xx`, and so on), and the gateway reconnects with backoff from 1 s to 30 s with jitter. The Servers page shows the state and the kind. Proof: `upstream.test.ts` ("turns unreachable after three failed attempts", "marks the server unreachable at once when a call is refused", "checks health at once after a connection reset ...", "reconnects when the upstream comes back on the same port"); `scripts/e2e.sh` ("fx call fails in ... with fx-mcp at zero", "main keeps answering while fx is down").
- A flapping upstream. A circuit breaker per upstream opens after 5 consecutive timeouts, refusals, DNS or TLS failures, stays open for 30 s, then lets one trial call through. Any answer from the upstream, an error included, resets the count. Proof: `resilience.test.ts` and `upstream.test.ts` ("opens the breaker after five timeouts and then fails fast").
- Too many calls at one upstream. A bulkhead allows 8 concurrent calls, queues up to 32 and waits at most 2 s. After that the answer is "Server `<slug>` is busy", audited as `timeout` (the SPEC outcome list has no `busy`), and the breaker does not count it. A client that cancels is audited as `upstream_error` with "cancelled by client", also not counted. Proof: `resilience.test.ts` (eight at once, queue of 32, 2 s), `upstream.test.ts` ("answers busy when the bulkhead queue wait runs out, without counting it", "reports a client cancel without counting it against the breaker").
- Name collisions. Two servers cannot collide because every tool is `<slug>__<tool>` and slugs are unique. Two tools of one server that map to one name: the first by original name is kept and the other is skipped with a warning.
- Other servers keep working. State, connection, breaker and bulkhead are per upstream, per replica. Proof: `scripts/e2e.sh` ("main keeps answering while fx is down").
- Several replicas. Each replica runs its own health checks, so tool lists agree within about 3 health intervals (~30 s). One replica, holding Postgres advisory lock 4242, writes the shared status that the dashboard reads.
- Errors do not carry upstream text. A failure message is built from error codes and status numbers, because an upstream body can echo a credential (`classify.ts`).
- Postgres trouble. Rate limiting fails open after 2 s so a database hiccup is not a tool outage (`docs/THREAT_MODEL.md`, section 12). A policy reload that fails is retried every 2 s while the old rules stay in force.
- A legacy-mode upstream keeps running a call after the gateway gave up on it, because the legacy SDK's cancel is a separate POST that a stateless upstream ignores. The gateway still answers at the timeout and frees its slot. `main` and `fx` are seeded with `protocol_mode = auto`, which does abort the request.

### The chat agent

- The browser posts to `/api/chat` with its session cookie. The agent sends that cookie to the control-plane (`POST /internal/sessions/introspect` on 3001, with a shared secret) and gets back the user and a JWT: `aud` is the gateway URL, `sub` is the user, `act` is `agent`, and it lives 300 s. The agent has no database access and never sees the user's API key.
- Per turn, the agent opens one MCP client to the gateway with that JWT and lists the tools. The gateway sees `via = agent`, applies the user's role policy and writes the audit rows under the user. A member's chat therefore has the member's tool list, and the Audit page shows the calls under their name.
- The loop: the system prompt plus the last 10 messages go to the model; text is streamed to the browser as `text` events; each tool call goes through the gateway and the result is clipped to 6000 characters before the model reads it; at most 8 model calls per turn. A turn stops at 240 s, so the JWT is still valid for every call. Each LLM request and each tool call has 60 s.
- Models: the primary is `gemini-3.5-flash-lite`, the fallback `openai/gpt-oss-120b` on Groq. A 429 retries the primary once if the advised wait is 30 s or less, otherwise goes to the fallback. SPEC 13 falls back on 429 only; we also fall back on 5xx, an unreachable host and a timeout, and retry a 503 once after 2 s. A 400 never falls back, and nothing falls back after text has streamed. Once the fallback answers it keeps the rest of the turn. The extra cases are deliberate: a provider outage is as bad for the demo as a rate limit. Proof: `llm.test.ts`, `model.test.ts`.
- Tool output is data. The prompt says so, and the role policy limits what an injected instruction could call (`docs/THREAT_MODEL.md`, section 9). The agent keeps no state between turns; the chat history is in the browser.

### Stores

- Creating a store from the dashboard inserts a `stores` row and a disabled managed server row. The provisioner (control-plane, under advisory lock 4243) runs `helm upgrade --install` of the store chart into namespace `store-<slug>` with the baked Helm CLI, then enables the server and waits until the gateway reports it connected. Ready therefore means "the gateway can call it", not "Helm returned". The deadline is 15 min and a failed release gets 3 attempts.
- Delete runs `helm uninstall --wait --cascade foreground`, waits for the namespace to go, and only then removes the row. If the namespace is still there after 5 min the store stays `deleting` with a reason and the next tick tries again.
- A restart mid-install is safe: recovery picks up `provisioning` and `deleting` rows and also handles releases left in `pending-*` states. `Idempotency-Key` makes create safe to retry.
- Guardrails: a ResourceQuota and a LimitRange per store namespace, 3 stores per user (the admin's count includes `main`), and the provisioning deadline.
- Deliberate changes from the SPEC, all for the VM: production stores use 2Gi MariaDB plus 2Gi WordPress (SPEC 28 says 10Gi each) so a store fits the 8Gi storage quota; the store quota's `limits.memory` is 2304Mi and `limits.cpu` 3500m so the wp-cron pod is not refused; `scripts/store-quota-sum.py` checks that the namespace keeps 200m CPU and 128Mi memory free.

### Local to production

The charts are the same. These values differ (`deploy/values-local.yaml`, `deploy/values-prod.yaml`, and the store pair):

| Concern           | Local (k3d)                                 | Production (k3s on the VM)                                                                                                                           |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain and scheme | `127.0.0.1.nip.io`, http                    | `vinayak-urum.me`, https                                                                                                                             |
| DNS               | none (nip.io resolves to 127.0.0.1)         | A records for `@`, `*` and `*.shop` to the VM's static IP                                                                                            |
| Images            | built locally, tag `dev`, imported into k3d | built by CI, pushed to `ghcr.io/vinayakjeet/<name>`, tag `<version>-<git sha>`, one tag for all seven images because stores use the platform tag too |
| Ingress and TLS   | Traefik, no TLS                             | Traefik, `ingress.tls.enabled`, cert-manager, ClusterIssuer `letsencrypt-prod`, one HTTP-01 certificate per host                                     |
| Storage           | `local-path`                                | `local-path` (k3s default); Postgres 5Gi, store volumes 2Gi each                                                                                     |
| Secrets           | generated by the chart on first install     | generated by the chart on first install; the LLM keys are a Secret made with `kubectl create secret` (`agent-llm`); k3s runs with secrets encryption |
| Gateway           | 1 replica, 120 calls a minute per key       | 2 replicas, a PodDisruptionBudget (min 1), 60 calls a minute, HPA off                                                                                |
| SSRF              | managed servers skip the check              | `upstreamDenyAddresses` lists the VM's public IP                                                                                                     |
| Hosted images     | `fx-mcp:`                                   | `ghcr.io/vinayakjeet/`, caps 500m and 256Mi                                                                                                          |
| Monitoring        | off                                         | Prometheus on                                                                                                                                        |

`make store` and `make platform` pick the values files from `ENV=local|prod`. Production also needs `IMAGE_TAG=<version>-<git sha>` on the command line, so a missing value cannot deploy a stale tag. HPA is off on the VM because a fixed two replicas is enough and the CPU credit balance stayed flat under load (see "Scaling").

### Choices and what they cost

- Postgres as the only bus (`LISTEN` and `NOTIFY`) instead of a broker. One fewer moving part, and the state is already there. The cost is that a missed notification needs a full reload, which `relisten` does.
- Stateless MCP, no sessions. Any replica serves any request and a pod kill is invisible to clients. The cost is no server push to legacy clients.
- Always prefixed tool names. Names stay stable when a server is added, and routing is one lookup. The cost is longer names.
- WooCommerce REST, not WP-CLI. It runs the store's business logic and permission checks and works across a NetworkPolicy. The cost is the OAuth 1.0a signing over plain http.
- One stored credential per upstream, not one per member. Simple, and members never hold credentials. The cost is that the upstream cannot tell members apart (`docs/THREAT_MODEL.md`, section 16).
- Provisioning with Helm in the control-plane pod instead of an operator. Fewer parts, and a recovery path that is a `helm` command. The cost is the control-plane needs the Helm CLI and API permissions, confined to `store-*` and `mcp-hosted` (`docs/THREAT_MODEL.md`, section 3).

### Where the build differs from the SPEC

- Fallback beyond 429, and a 503 retry (above).
- Slug length: 2 to 24 characters, because the SPEC's own examples `fx` and `gh` have 2 (see "Naming and collisions").
- Audit outcomes: a full bulkhead queue is `timeout` and a client cancel is `upstream_error`, because the SPEC's outcome list has no `busy` or `cancelled`.
- The 10 s health `tools/list` also refreshes the tool list, which covers the 60 s refresh in SPEC 6.3. `mcp_tools` is written only when a tool's name or definition hash changed.
- Store sizes and quota in production (above).
- Local models are Gemini and Groq, where SPEC 28 names others.
- Migration 0001 treats a tool as already approved only if it is active and its server is approved. Tools that were changed, removed or on a pending server keep no approved hash. The policy seed sends `policies_changed` and `tools_changed` in the same transaction as its insert, so running gateways pick the rules up.

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
- Tool list across replicas. The tool list is eventually consistent across gateway replicas, within about 3 health intervals (~30 s); calls to a down server fail cleanly meanwhile. Each replica checks every upstream every 10 s and marks it unreachable after 3 failed checks, or at once when a real call has just failed and the next check is refused. The status row (and so the dashboard) comes from the replica holding lock 4242, which can be ahead of the others. Seen on the VM: one replica answered `tools/list` with the fx tools about 12 s after the dashboard showed fx unreachable. `e2e.sh` polls `tools/list` for up to 35 s and prints how long it took.
- Stop. A pod that gets SIGTERM can still receive calls that Traefik routed a moment earlier. The gateway has `preStop: sleep 5`, which keeps it listening while Traefik and the EndpointSlice drop it, then SIGTERM and a drain of at most 5 s. `terminationGracePeriodSeconds` is 15 for the gateway (10 for the other Node services). `lifecycle.preStop.sleep` needs Kubernetes 1.30 or later.
- PodDisruptionBudget. `minAvailable: 1`. The chart refuses to render it for one replica without the HPA, because it would block every node drain.
- HPA (`gateway.hpa.enabled`). `autoscaling/v2`, CPU 70% of the 50m request, 2 to 4 replicas. With the HPA on, the Deployment leaves out `replicas`, so a Helm upgrade does not reset what the HPA chose. The cost of that rule: switching an existing release from a fixed count to the HPA drops the Deployment to one replica until the HPA acts (seen on k3d in M12 Task 15: 2 pods, then 1, then 2 again within a minute). In production turn the HPA on from the first deploy with `minReplicas` of 2 or more.
- Postgres connections. Each replica holds a pool of up to 5 plus two dedicated connections (the NOTIFY listener and the status lock). Four replicas use 4 x 7 + 6 for the control-plane = 34 of the 100 allowed. With two replicas and the demo running, `pg_stat_activity` showed 14.
- Proof, on k3d, with `--set gateway.replicas=2 --set gateway.pdb.enabled=true`. `scripts/replica-demo.sh` sends 20 calls through the Ingress and deletes a pod after call 8. Three runs, each 20 of 20 ok, with two pod names before the delete. Evicting one gateway pod answered 201 and evicting the second right after answered 429 (TooManyRequests, the disruption budget). A key with limit 5 got 5 ok and 2 rate limited across both replicas. e2e, chat-check and obs-check ended OK with two replicas. The HPA showed `cpu: 24%/70%` with 2 replicas.
- On the VM (M8 Task 10, Standard_B4ms, 4 vCPU, 15.5 GiB allocatable). Measured on 2026-10-18 with two gateway pods and Prometheus on: 860m CPU and 1900Mi memory requested, about 170m CPU and 2.4 GiB used, so about 3140m CPU and 13.7 GiB are unrequested. Each gateway pod used 4 to 6m CPU against its 50m request. The HPA stays off (`gateway.hpa.enabled: false`): two fixed replicas with the PDB already survive a pod delete and a node drain, no load has come close to the 35m trigger (70% of 50m), and a burstable VM spends CPU credits when it scales out, so a scale-out needs a load test and a tuned request before it helps. Headroom is not the reason. `hosted.maxCpu` and `hosted.maxMemory` stay at 500m and 256Mi and are written out in `values-prod.yaml`: a hosted pod requests a fixed 20m and 64Mi whatever its limit, so the cap only bounds the limit, and ten servers at the cap would limit 5000m and 2.5 GiB against that headroom.
- Proof on the VM, through https. `replica-demo.sh` ended 20 of 20 ok with a pod deleted, twice (the second time with `pg_stat_activity` sampled every 2 s: 14 idle, 18 at most, `max_connections` 100). Evicting the first gateway pod answered 201 and the second right after answered 429 (TooManyRequests), then the Deployment returned to 2 ready pods. Prometheus (`prom/prometheus:v3.15.0`, pulled from Docker Hub, restricted PSA namespace, requests 50m and 128Mi, 0 restarts) had the control-plane and both gateway pods up. `obs-check.sh` ended OK: a `traceparent` sent to `https://mcp.vinayak-urum.me/mcp` showed its trace id in the gateway and woo-mcp logs. The stats API behind the Health page listed `main` with 21 calls, p50 138 ms and p95 200 ms in the last 60 minutes.

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

## OAuth on k3d is plain http by design (SPEC 24)

Clients refuse to send credentials to a token endpoint that is not https, unless its host is `localhost`, `127.0.0.1` or `::1`. This is the rule of the MCP SDK 2.x client (MCP Inspector 2.9.0 stopped at the token step with it) and of Claude Code on its default v2 runtime (docs, "MCP client runtimes", and the check in the 2.1.301 binary). The local stack serves `http://app.127.0.0.1.nip.io`, and a nip.io name is not exempt.

What that means for this repo:

- The OAuth endpoints are written for https. `OAUTH_ISSUER` is `<scheme>://app.<domain>` from the chart, so on the VM it is https and the metadata documents carry https URLs.
- On k3d everything up to the token step works with a real browser client: discovery, registration with CORS, login, the consent page and Deny. The token step and a call with the token are proven with `scripts/oauth-check.sh`, which talks to the server directly.
- The proof with a real client was done on the VM over TLS on 2026-10-17: Inspector 2.9.0 and Claude Code both completed consent and called `main__get_info`, and Claude Code refreshed its token without a browser. `oauth-check.sh` ends `OK` there.
- API keys and agent JWTs work over http locally, as before.
- Not done on purpose: a token URL override in the client, local TLS with a private CA, and the `MCP_SDK_GENERATION=v1` runtime switch in Claude Code. The rest of the OAuth design follows.

## OAuth (SPEC 24)

OAuth is for MCP clients that sign in through a browser. API keys and agent JWTs stay as they are. With `oauth.enabled: false` (the chart default) there are no OAuth routes, no resource metadata and no `WWW-Authenticate` header. `values-local.yaml` turns it on.

### The flow, first 401 to refresh

1. A client posts to `mcp.<domain>/mcp` with no token. The gateway answers 401 with `WWW-Authenticate: Bearer resource_metadata="<mcp origin>/.well-known/oauth-protected-resource", scope="mcp:tools"`. If a token was sent and rejected, `error="invalid_token"` is added so the client knows to refresh. The metadata is also served at the path-aware URL the SDK builds.
2. The metadata names the authorization server, `https://app.<domain>`. Its document is at `/.well-known/oauth-authorization-server`.
3. The client registers (`POST /oauth/register`, DCR) or uses an https URL as its `client_id` (CIMD, see THREAT_MODEL 14).
4. The client sends the browser to `/oauth/authorize` with a PKCE S256 challenge. With no session this redirects to `/login?next=...` and the login page returns to the same URL.
5. The consent page shows the client, the redirect URI and the signed-in email. Approve or Deny answers 303 to the redirect URI with `code`, `state` and `iss` (RFC 9207), or `error=access_denied`.
6. `POST /oauth/token` swaps the code and the PKCE verifier for an access token and a refresh token. The client sends the access token to the gateway as a Bearer header.
7. About 15 minutes later the gateway answers 401 with `invalid_token`. The client posts the refresh token to `/oauth/token` and gets a new pair. No browser is involved.

### Token shapes

- Access token: a JWT, header `alg: EdDSA`, `typ: at+jwt`, `kid`. Claims: `iss` (`https://app.<domain>`), `aud` (the gateway URL), `sub` (user id), `client_id`, `scope` (`mcp:tools`), `iat`, `exp` (`iat` + 900 s), `jti`. The gateway accepts only that algorithm and type, equal `iss` and `aud` strings, and a clock skew of 30 s. It reads the user row on every call, so a disabled user is refused at once.
- Refresh token: `urt_` plus 43 characters, valid 30 days, stored only as a hash. Authorization codes live 60 s and are stored as hashes too.
- A call made with an OAuth token is audited with `via = oauth` and counted in the rate limit under the user, like the agent.

### Key derivation (decision A1)

The Ed25519 key pair comes from `JWT_SIGNING_KEY` with HKDF-SHA256, an empty salt and 32 bytes of output. Three info labels keep the uses apart: `urumi oauth eddsa v1` (signing seed), `urumi oauth csrf v1` (consent CSRF key) and `urumi oauth refresh v1` (the replay key in THREAT_MODEL 14).

- Why: no new Secret and no chart change. The gateway derives the public key once at start.
- Cost: the gateway holds the same key, so a gateway compromise could mint tokens. The code only verifies.
- Rotating `JWT_SIGNING_KEY` ends every OAuth access token and agent JWT at once. Refresh tokens survive, because they are opaque rows in Postgres.

### Registration

- DCR takes public clients only (`token_endpoint_auth_method: none`). PKCE is the proof of possession, so no client secret exists.
- `redirect_uris`: 1 to 5, each an https URL or an http URL on `localhost`, `127.0.0.1` or `[::1]`, with no fragment, no userinfo, at most 2000 characters. `client_name` is cut to 100 characters with control characters removed. The `client_id` is `dcr_` plus 22 characters.
- Redirect matching is an exact string. The one exception is the loopback port (RFC 8252 7.3): a native app picks a free port each run, so the port is ignored. Scheme, host, path and query must still match, and `localhost.evil.example` is not loopback.
- A custom URL scheme (`cursor://...`) cannot register. This is a known limit: the consent page cannot tell which app on a device owns a private-use scheme. Cursor is the known case. API keys work for it.
- A `client_id` that starts with `https://` is a CIMD URL. The control-plane fetches the document on every authorize and on the consent POST (5 s, 5 KB, no cache, no fallback to an older copy).
- Per IP and minute: 10 registrations, 30 token requests, 30 CIMD fetches.

### Consent and CSRF

The consent page is plain HTML from the control-plane, with no script. Its CSP has `frame-ancestors 'none'` and a `form-action` that names the redirect origin (Chrome applies `form-action` to the redirect after the POST). The POST carries a hidden token: an HMAC of the session id and the authorization request, so it is bound to this user and this request. The existing Origin check still runs on the POST.

The page sends `Referrer-Policy: same-origin`. With `no-referrer`, browsers sent `Origin: null` on the form post and the Origin check refused every approval (found in the Task 7 browser check). Same-origin still sends no Referer to the client.

### CORS and the Origin check

`/.well-known/oauth-authorization-server`, `/oauth/register` and `/oauth/token` answer `Access-Control-Allow-Origin: *` without credentials, so a browser client such as MCP Inspector can call them. `/oauth/authorize` is a navigation and has no CORS. The control-plane Origin hook skips `/oauth/register` and `/oauth/token`: neither reads a cookie, so there is nothing to forge. The gateway serves its resource metadata with open CORS too.

### Refresh rotation

Every refresh returns a new token and revokes the old one. A reuse revokes the whole chain, except for a 30 s grace window for the direct parent, so two parallel refreshes or a retry after a lost answer do not kill the grant. The rules and the trade-off are in THREAT_MODEL 14.

### What clients were tried

- MCP Inspector 2.9.0 (pinned; published 2026-09-30): discovery, registration, login, consent and Deny worked on k3d. It stopped at the token step, because the token endpoint is plain http (above). Proof on the VM over TLS is pending (M8).
- Claude Code: not tried on k3d, for the same reason. Its proof, with its own CIMD document, is pending on the VM (M8).
- Server side: `scripts/oauth-check.sh` drives the whole flow with curl: discovery, registration, consent with the headers a browser would send, the token step, a call, rotation and reuse, CIMD, Connected apps and revoke.

## Connected apps (Task 10b)

A grant is one user and one client, the key of `oauth_consents`. My keys lists the signed-in user's grants: client name, `unverified` for DCR or the host for CIMD, and the last refresh. `GET /api/oauth/grants` returns them (an admin may add `?userId=`; a member naming another user gets 403). `DELETE /api/oauth/grants/<client_id>` revokes: it sets `revoked_at` on every live refresh token of the pair, marks unredeemed codes used and deletes the consent row. Both routes exist only when OAuth is enabled.

- Revoke takes effect on the next call. The gateway reads the consent row in the same query as the user row. A token with no consent row is refused, and so is a token issued before the second of the row's latest approval, so revoke then approve again does not revive an old token.
- One audit row per revoke, `tool_name = oauth_grant_revoked`, with an empty server slug. The Audit page shows it as "Revoked by <email>", not as a failed call. No schema change: a dedicated events table would need a migration.

## Naming and collisions (SPEC 5)

- Exposed name: `<slug>__<tool>`, always prefixed, never only on a collision. Names stay stable when a server is added, the model and the audit log know the source, and routing is one map lookup.
- Slug: `^[a-z][a-z0-9-]{0,22}[a-z0-9]$`, so 2 to 24 characters, no `__`. SPEC 5 writes `{1,22}`, which needs 3 characters, but its own examples `fx` and `gh` have 2 (user approved 2026-10-11).
- Tool part: characters outside `[A-Za-z0-9_-]` become `_`. If the name is longer than 48 characters, the tool part is cut and `_` plus the first 6 hex characters of the sha256 of the original name is appended. 48 leaves room for client prefixes such as `mcp__<server>__` inside the 64-character limit of common model APIs.
- Two tools of one server that map to one exposed name: the gateway sorts them by original name, keeps the first and skips the other with a warn log (`exposed name collision, tool skipped`).
- `tools/list` is sorted by exposed name. Descriptions start with `[<server name>] `, or `[Store: <store name>] ` for a store.
- Demo: woo-mcp and fx-mcp both have `get_info`, which appear as `main__get_info` and `fx__get_info`.

## Audit retention (SPEC 9)

The control-plane deletes `audit_events` rows older than 30 days. It runs at start and every 24 hours, on every replica, whether or not the provisioner is on. A try-lock (advisory lock 4244) lets one replica prune and the others log `audit retention skipped, lock held`. The cutoff is Postgres `now()`, never the pod clock, which can jump. Deletes go in batches of 10000 until a batch is short, and the count is logged as `audit retention`. A deleted store or server leaves its audit rows until they age out.

## List changes (SPEC 6.6)

A client on the 2026-07-28 protocol opens `subscriptions/listen` and hears `notifications/tools/list_changed` when its tool list may have changed. Then it lists again and gets its own filtered list.

- The event has no payload on purpose: it says nothing about a server a member cannot see.
- Senders: the control-plane sends `NOTIFY tools_changed` inside `notify()` for every `registry_changed` and `policies_changed`, in the same transaction, so a new call site cannot forget it. The gateway sends it when a server's state changes (status writer, leader only) and when a tool sync writes a changed tool set. Every replica LISTENs and writes to its own open streams.
- Events within 100 ms give one notification. When the LISTEN connection comes back, every open stream gets one, because notifications may have been lost.
- A stream is authenticated once, so the gateway authenticates again before every send and every 60 s. A revoked key, a deleted consent row, an expired token or a disabled user closes the stream. A failed check (database down) keeps it, since a stream carries no data.
- At most 3 open streams per API key, or per user for a token without a key, on one replica. The 4th gets 429 with `Retry-After: 60`. With N replicas a client can hold 3N.
- The gateway declares `tools.listChanged` only to modern requests. A legacy client has no push channel and sees changes on its next `tools/list`.
