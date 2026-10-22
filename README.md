# woo-mcp-gateway

WooCommerce stores on Kubernetes, our own WooCommerce MCP server, a team MCP gateway with a React dashboard, and a chat agent. One gateway URL and one personal API key give an MCP client the tools of every enabled server.

It runs on k3d locally and on a k3s VM (Azure, Let's Encrypt certificates) with the same Helm charts. Only values files differ.

Live deployment: https://app.vinayak-urum.me (dashboard). Demo access on request.

| Read                                         | For                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [docs/DESIGN.md](docs/DESIGN.md)             | System design and tradeoffs: components, the path of a tool call, failure handling, local to production      |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Shared upstream credentials, why client tokens are not passed on, untrusted upstreams, member against member |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)     | Deploy, upgrade, rollback, backup and restore, SSH and certificate upkeep, incident checks                   |

Layout: `apps/` (gateway, control-plane, web, agent), `servers/` (woo-mcp, fx-mcp), `packages/core`, `charts/` (platform, store), `deploy/` (values files), `scripts/` (live checks).

## Prerequisites

- Docker, k3d 5.9.0, kubectl and Helm 4.3.0.
- Node.js 24 and pnpm 10.34.6 (`corepack enable` picks the pnpm pinned in `package.json`).
- jq, curl and openssl (the Makefile and scripts use them).
- For the chat agent: a Gemini API key (primary) and a Groq API key (fallback). Free tiers work, with rate limits.
- For the third upstream (optional): a GitHub fine-grained personal access token limited to one repo, `store-ops`, with Issues read and write.

## Local setup

```bash
pnpm install
make cluster                              # k3d cluster "urumi", host ports 80 and 443
make images                               # 7 images; store-wordpress is about 856 MB
make store SLUG=main NAME="Main Store"    # WordPress, MariaDB and woo-mcp in namespace store-main
kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
# Each LLM key comes from a file, so it never lands in shell history or a process list.
kubectl -n platform create secret generic agent-llm \
  --from-file=LLM_API_KEY=<gemini key file> --from-file=LLM_FALLBACK_API_KEY=<groq key file>
make platform                             # Postgres, control-plane, gateway, web, agent, fx-mcp
kubectl -n platform get pods              # 6 pods, all 1/1 Running
```

`NAME` counts only on the make command line. WSL exports `NAME` as the machine name, and the Makefile ignores it.

Sign in at http://app.127.0.0.1.nip.io with the bootstrap admin:

```bash
kubectl -n platform get secret platform-bootstrap -o jsonpath='{.data.ADMIN_EMAIL}' | base64 -d; echo
kubectl -n platform get secret platform-bootstrap -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d; echo
```

GitHub upstream (optional): on the Servers page, add a server with slug `gh`, URL `https://api.githubcopilot.com/mcp/` and a Bearer credential set to the token. The dashboard never shows the token again.

After a code change, rebuild only that image and restart it, for example `make image-gateway` then `kubectl -n platform rollout restart deploy/gateway`. `make images` also rebuilds the WordPress image.

## Local domains (nip.io)

Public DNS answers 127.0.0.1 for any name under `127.0.0.1.nip.io`, so these hosts reach the k3d load balancer on port 80 with no `/etc/hosts` edits. Traefik routes by Host.

| Host                         | What                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `main.shop.127.0.0.1.nip.io` | Storefront and wp-admin of store `main`                               |
| `app.127.0.0.1.nip.io`       | Dashboard; `/api` goes to the control-plane, `/api/chat` to the agent |
| `mcp.127.0.0.1.nip.io/mcp`   | Gateway endpoint for MCP clients                                      |

Why: each store gets its own host name (`<slug>.shop.<domain>`) as in production, WordPress keeps one stable home URL (woo-mcp signs requests with it, see below), and the same values file works on every machine. A production install sets its real domain in `global.domain`.

If `getent hosts app.127.0.0.1.nip.io` prints nothing, your resolver blocks answers that point at 127.0.0.1 (DNS rebinding protection). Add the three names to `/etc/hosts` with address 127.0.0.1 (on WSL, also to the Windows hosts file for the browser).

## Place an order

1. Open http://main.shop.127.0.0.1.nip.io, add a product to the cart and check out as a guest. Shipping is off, so checkout asks only for billing details.
2. Choose Cash on delivery and place the order.
3. Sign in to http://main.shop.127.0.0.1.nip.io/wp-admin and open WooCommerce, Orders. The order is there with status Processing.

wp-admin credentials:

```bash
kubectl -n store-main get secret store-wp -o jsonpath='{.data.WP_ADMIN_USER}' | base64 -d; echo
kubectl -n store-main get secret store-wp -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d; echo
```

The same guest checkout as a script, through the Store API: `pnpm tsx scripts/store-checkout-smoke.ts`.

## Connect an MCP client

Create a key on the My keys page. The key is shown once, and the page shows the snippets below with it filled in. Tools appear as `<server>__<tool>`, for example `main__list_orders` or `fx__convert_currency`. Revoking the key makes the next call answer 401 within 1 s.

Claude Code:

```bash
claude mcp add --transport http urumi http://mcp.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <key>"
```

Then `/mcp` in Claude Code lists the server and its tools. Try "How many orders did the store get today?"

Cursor, in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://mcp.127.0.0.1.nip.io/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

MCP Inspector: run `npx @modelcontextprotocol/inspector`, then in the page it opens set Transport Type to Streamable HTTP, URL to `http://mcp.127.0.0.1.nip.io/mcp`, add header `Authorization` with value `Bearer <key>`, and press Connect, then List Tools.

OAuth instead of a key (needs https, so it works on the VM and not on the local stack): `claude mcp add --transport http urumi-oauth https://mcp.<domain>/mcp` with no header. Claude Code opens the browser for sign-in and consent, and refreshes the token without asking again. My keys lists these apps under Connected apps and can revoke them. On the local stack the token endpoint is plain http, and Claude Code and MCP Inspector 2.x refuse that off loopback, so there OAuth is proven server side by `scripts/oauth-check.sh`. On the VM, over TLS, both clients were proven on 2026-10-17: Claude Code (Client ID Metadata consent, tools, `main__get_info`, a silent refresh after the 15 minute access token) and MCP Inspector 2.9.0 (connect, consent, tools, `main__get_info`). Design: `docs/DESIGN.md`, "OAuth".

From a terminal: `pnpm tsx scripts/mcp-smoke.ts http://mcp.127.0.0.1.nip.io/mcp <key> [tool] [json args]`.

## Use the chat agent

Open http://app.127.0.0.1.nip.io/chat. The agent calls the gateway as the signed-in user, so it sees that user's tools and every call lands in the audit log with via `agent`. Each tool call shows as a chip with its arguments and duration; open it for the result. History stays in the browser, per user.

Prompts for a demo:

- "How many orders today?" (`main__get_info`, or `main__list_orders` with `date: today`)
- "Create a product called Ginger Tea 100g priced at 180." Then refresh the storefront.
- "Total sales today in USD." (main and fx)
- "Open an issue in store-ops listing today's on-hold orders." (main and gh)

Models (`deploy/values-local.yaml`): primary `gemini-3.5-flash-lite`, fallback `openai/gpt-oss-120b` on Groq. Free tiers answer 429 or 503 in bursts. The agent retries the primary once, then uses the fallback, and when both are limited it says so with the wait in seconds.

## Production on a VPS (k3s)

The VM deployment uses the same two charts, `charts/platform` and `charts/store`, with `deploy/values-prod.yaml` and `deploy/store-values-prod.yaml` instead of the local files. The full runbook with every command and the dates it was run is [docs/OPERATIONS.md](docs/OPERATIONS.md); this section is the outline.

What the VM needs:

- A Linux host with k3s 1.30 or later (the VM runs `v1.36.5+k3s1`, installed with `--secrets-encryption`). Traefik, kube-router and local-path storage stay on, because the charts rely on them.
- DNS A records for the domain, `*` and `*.shop` pointing at the VM. `*` covers `app.` and `mcp.`; `*.shop` covers store hosts (`<slug>.shop.<domain>`).
- Ports 80 and 443 open. Port 6443 stays closed: `make tunnel-up` opens an SSH tunnel to the API server on local port 16443 and the kubectl context `urumi-vm` points at it.
- cert-manager with the two ClusterIssuers in `deploy/cert-manager/` (HTTP-01 through Traefik).
- Images in a registry the VM can pull. CI builds them: pushing a tag `vX.Y.Z` runs `.github/workflows/images.yml`, which pushes all seven images as `ghcr.io/<owner>/<name>:X.Y.Z-<git sha>`. `make images` refuses `ENV=prod`.

```bash
make tunnel-up
make store ENV=prod SLUG=main NAME="Main Store" IMAGE_TAG=<version>-<git sha>
make platform ENV=prod SLUG=main IMAGE_TAG=<version>-<git sha>
```

`ENV=prod` selects the prod values files and the `urumi-vm` context, and it refuses to run without `IMAGE_TAG`. Create the `agent-llm` Secret first (see OPERATIONS, section 2).

What changes between local and production, all through values:

| Concern    | Local (`deploy/values-local.yaml`, `deploy/store-values-local.yaml`)                      | Production (`deploy/values-prod.yaml`, `deploy/store-values-prod.yaml`)                         |
| ---------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Domain     | `global.domain: 127.0.0.1.nip.io`, `global.scheme: http`                                  | `global.domain: vinayak-urum.me`, `global.scheme: https`                                        |
| Ingress    | Traefik, TLS off                                                                          | Traefik, `ingress.tls.enabled: true`, `ingress.tls.clusterIssuer: letsencrypt-prod`             |
| Images     | `images.registry` empty, `global.imageTag: dev`, imported into k3d                        | `images.registry: ghcr.io/vinayakjeet`, tag passed with `--set global.imageTag=<version>-<sha>` |
| Storage    | `local-path`, Postgres 2Gi (chart default), store volumes 2Gi + 2Gi                       | `local-path`, Postgres 5Gi, store volumes 2Gi + 2Gi (`provisioner.store.storage`)               |
| Secrets    | Files in the git-ignored `deploy/secrets/`, `agent-llm` made with `kubectl create secret` | The same, with a separate store token file per environment (`store-<slug>-prod.yaml`)           |
| Gateway    | 1 replica, rate limit 120 per minute                                                      | 2 replicas, PodDisruptionBudget, rate limit 60, `gateway.upstreamDenyAddresses` lists the VM IP |
| Hosted     | `hosted.allowedImagePrefixes: ['fx-mcp:']`                                                | `['ghcr.io/vinayakjeet/']`, caps 500m CPU and 256Mi                                             |
| Monitoring | off                                                                                       | `monitoring.enabled: true` (Prometheus)                                                         |

Upgrade and rollback are `make platform ENV=prod ... IMAGE_TAG=<new tag>` and `helm --kube-context urumi-vm rollback platform <revision> -n platform`. OPERATIONS sections 4 to 6 give the checks and the run of 2026-10-19.

## What stands out

The nine optional items of the brief and the bonus. Each line says where it lives and what backs it. "On the VM" means run against the Azure VM over TLS; the date is in [docs/OPERATIONS.md](docs/OPERATIONS.md) or the section named.

1. **Production-like VPS deployment.** `deploy/values-prod.yaml`, `deploy/store-values-prod.yaml`, [docs/OPERATIONS.md](docs/OPERATIONS.md). Backed by the live deployment (k3s, Let's Encrypt, GHCR images) and `scripts/test-platform-chart.sh` and `scripts/test-store-chart.sh`, which render the charts with the prod values. On the VM: `scripts/e2e.sh` 38 PASS and `scripts/oauth-check.sh` 29 passed.
2. **Tool permissions.** Rules by role, server and tool in `packages/core/src/policy.ts`, edited on the Policies page. Members get `list_*` and `get_*` by default; hidden tools are absent from the list and rejected like unknown ones. Backed by `packages/core/src/policy.test.ts`, `apps/gateway/src/mcp.test.ts` ("hides tools from a member that the seeded rules do not allow", "answers a hidden tool exactly like a missing one") and the role-policy rows of `scripts/e2e.sh`.
3. **OAuth on the gateway.** Authorization code with PKCE, client ID metadata documents, dynamic registration, refresh rotation; [docs/DESIGN.md](docs/DESIGN.md) "OAuth", [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) section 14. Backed by `apps/control-plane/src/oauth-*.test.ts` and `scripts/oauth-check.sh`. On the VM on 2026-10-17: Claude Code and MCP Inspector 2.9.0 completed the browser flow, called `main__get_info`, and Claude Code refreshed without a prompt.
4. **Handling many tools.** `?toolMode=search` exposes only `search_tools` and `call_tool`; `auto` switches at 41 visible tools; `apps/gateway/src/search.ts`, [docs/DESIGN.md](docs/DESIGN.md) "Tool search mode". Backed by `apps/gateway/src/search.test.ts` and `search-mode.test.ts`. On the VM on 2026-10-18 Claude Code listed exactly those two tools.
5. **Hosted MCP servers.** An admin adds a server by image; the platform applies a Secret, Deployment, Service and NetworkPolicy in `mcp-hosted` and removes them on delete; `apps/control-plane/src/hosted-manifests.ts`, [docs/DESIGN.md](docs/DESIGN.md) "Hosted servers". Backed by `hosted-manifests.test.ts` and `hosted-reconcile.test.ts`, and on the VM by `scripts/hosted-check.sh all` (15 checks) and `scripts/netpol-check.sh hosted fx2`.
6. **Security hardening.** [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) sections 1 to 10.
   - SSRF guard: `packages/core/src/ssrf.test.ts`; on the VM the platform's own URL and IP answer 400 `url_rejected` (2026-10-20).
   - Least-privilege RBAC and a ValidatingAdmissionPolicy: `scripts/vap-check.sh` (7 checks).
   - Default-deny NetworkPolicies: `scripts/netpol-check.sh platform|main`.
   - Non-root, read-only filesystems, dropped capabilities: asserted by `scripts/test-platform-chart.sh` and `scripts/test-store-chart.sh`.
   - Credentials encrypted with AES-256-GCM, bound to the server slug: `packages/core/src/crypto.test.ts`.
   - Tool pinning against changed tool definitions: `scripts/approvals-check.sh`.
7. **Scaling.** Two gateway replicas with a PodDisruptionBudget in `deploy/values-prod.yaml`; rate limits per key and per user in Postgres (`apps/gateway/src/rate-limit.ts`); [docs/DESIGN.md](docs/DESIGN.md) "Scaling". Backed by `apps/gateway/src/rate-limit.test.ts` and `scripts/replica-demo.sh` (20 of 20 calls ok with a pod deleted mid-run, on the VM).
8. **Observability.** Prometheus metrics on the gateway and control-plane, the Health page (rate, p50, p95 per server), request ids and W3C trace ids across services; [docs/DESIGN.md](docs/DESIGN.md) "Observability". Backed by `scripts/obs-check.sh` (12 checks, on the VM). Upstream failures are reported with a reason from a fixed list (`timeout`, `refused`, `dns`, `tls`, `protocol`, `http_4xx`, `http_5xx`, `blocked`, `unknown`), as in `apps/gateway/src/classify.ts`.
9. **Upgrades and rollback.** [docs/OPERATIONS.md](docs/OPERATIONS.md) sections 4 to 6. Backed by a run on the VM on 2026-10-19: upgrade to a new tag (Helm revision 4), `helm rollback` to revision 3 (recorded as revision 5), `scripts/e2e.sh` and `scripts/chat-check.sh` passing after each, and a `mariadb-dump` restored into a throwaway container with matching counts.
10. **Bonus: multi-store provisioning.** The Stores page creates and deletes stores. Each is a Helm release in its own namespace `store-<slug>` with its own database, Secrets, volumes, Ingress host, ResourceQuota, LimitRange and NetworkPolicies, and registers its own `<slug>__*` tools in the gateway. A per-user limit and a 15 minute provisioning timeout apply, and a restart of the control-plane mid-provisioning resumes; `apps/control-plane/src/api-stores.ts`, [docs/DESIGN.md](docs/DESIGN.md) "System overview", "Stores". Backed by `api-stores.test.ts` and `api-stores-delete.test.ts`, and on the VM by `scripts/stores-check.sh all` (33 checks, including a control-plane kill mid-provision and the teardown check) and `scripts/netpol-check.sh main`. A recorded run of the chat agent comparing today's orders across two stores is not made yet.

## How woo-mcp talks to the store, and why

- woo-mcp calls the WooCommerce REST API v3 at the store's in-cluster Service, `http://wordpress.store-<slug>.svc.cluster.local`.
- Why REST: it is the official versioned API, it runs the same business logic as wp-admin (stock, totals, hooks), it checks permissions per key, and it works across a NetworkPolicy without shell access. WP-CLI would need exec rights into the WordPress pod or a privileged sidecar, and it skips the REST permission checks.
- Credentials: the store bootstrap Job creates one `read_write` WooCommerce key (description `mcp-gateway`, `images/store-wordpress/create-api-key.php`). Its consumer key and secret live in the Secret `store-wc-api`.
- Signing: traffic inside the cluster is plain HTTP, and over plain HTTP WooCommerce accepts only OAuth 1.0a one-legged signatures (Basic auth needs HTTPS). woo-mcp signs every request with HMAC-SHA256 (`servers/woo-mcp/src/oauth.ts`): a 32-character nonce, a timestamp and every query parameter, percent-encoded and sorted. The base string uses the store's home URL (`WC_SIGNING_BASE_URL`, for example `http://main.shop.127.0.0.1.nip.io`) plus the path, because WooCommerce rebuilds the base string from its home URL, not from the Host it received.
- Data minimization: the mappers in `servers/woo-mcp/src/mappers.ts` pick each field by name and never spread a WooCommerce object. Customer email, phone, street address and IP never leave woo-mcp. Order lists carry the customer's first name; order details add the billing city. Each tool returns `structuredContent` and a one-line text summary.
- Defense in depth: a NetworkPolicy lets only the gateway reach woo-mcp, and woo-mcp also requires a bearer token (Secret `store-mcp-token`) that the gateway keeps encrypted.
- woo-mcp reads the store name, URL, timezone and currency once per process. After renaming a store, restart it: `kubectl -n store-<slug> rollout restart deploy/woo-mcp`.

## Checks

```bash
make e2e S=<private dir>                   # live end to end checks, ends with OK
S=<private dir> scripts/chat-check.sh      # agent hardening and one chat turn, ends with OK
S=<private dir> scripts/demo-reset.sh      # demo state; keeps orders, products and chat history
S=<private dir> scripts/obs-check.sh       # metrics, request ids and trace ids across services, ends with OK
S=<private dir> scripts/oauth-check.sh     # OAuth flow, consent, refresh, disabled member; ends with OK
scripts/netpol-check.sh platform           # NetworkPolicy probes; also <slug> (a store) and hosted <slug>
S=<private dir> scripts/vap-check.sh       # admission policy that confines the control-plane
S=<private dir> scripts/stores-check.sh all    # create, kill the control-plane mid-provision, delete; about 15 minutes
S=<private dir> scripts/hosted-check.sh all    # hosted server create, check, delete
scripts/test-platform-chart.sh             # renders the charts with both values files and asserts them
scripts/test-store-chart.sh
pnpm -r test                               # unit tests; set TEST_DATABASE_URL for the Postgres ones
```

Against the VM, run the same scripts with `APP`, `MCP`, `EXPECT_CONTEXT=urumi-vm` and a flattened `KUBECONFIG` as in [docs/OPERATIONS.md](docs/OPERATIONS.md), section 1.

## Scale and metrics (M12)

Local values run one gateway and no Prometheus. Turn the extras on with `--set` and restore with a plain `make platform`:

```bash
# Two gateway replicas, a PodDisruptionBudget, then the demo (20 calls, one pod deleted mid-run).
make platform HELM_FLAGS="--wait --rollback-on-failure --timeout 15m --set gateway.replicas=2 --set gateway.pdb.enabled=true"
S=<private dir> scripts/replica-demo.sh    # each call prints the answering pod; ends with 20 of 20 ok and OK

# Prometheus (no Grafana, no Ingress): scrapes the gateway on 9090 and the control-plane on 3001.
make platform HELM_FLAGS="--wait --rollback-on-failure --timeout 15m --set monitoring.enabled=true"
kubectl -n platform port-forward deploy/prometheus 19091:9090   # then open http://localhost:19091
# try: rate(gateway_tool_calls_total[5m])   and   sum by (outcome) (gateway_tool_calls_total)

make platform                              # back to one gateway, no Prometheus
```

The Health page in the dashboard shows the last 60 minutes per server without Prometheus. Key rate limits are set on the Members page (Limit/min); the default is `gateway.rateLimitPerMinute` (120 locally, 60 in the chart). If you use the HPA (`--set gateway.hpa.enabled=true`) in production, turn it on from the first deploy with `minReplicas` 2 or more: switching later from a fixed count drops the gateway to one pod until the HPA acts.

## Pinned versions

| Tool               | Version                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| Node.js            | 24 (engines `>=24`)                                                           |
| pnpm               | 10.34.6                                                                       |
| WordPress image    | `wordpress:7.1.3-php8.3-apache`                                               |
| WooCommerce        | 10.9.4                                                                        |
| wp-cli             | 2.12.0                                                                        |
| MariaDB            | `mariadb:11.4.13`                                                             |
| Helm               | 4.3.0 (CLI and the control-plane image)                                       |
| k3d                | 5.9.0                                                                         |
| React              | 19.3.0                                                                        |
| React Router       | 7.18.4                                                                        |
| TanStack Query     | 5.104.0                                                                       |
| Vite               | 8.3.1                                                                         |
| Tailwind CSS       | 4.3.3                                                                         |
| nginx-unprivileged | `nginxinc/nginx-unprivileged:1.31.6-alpine`                                   |
| ipaddr.js          | 2.5.0 (core, SSRF ranges)                                                     |
| undici             | 8.11.2 (gateway, pinned upstream connections)                                 |
| minisearch         | 7.2.0 (gateway, tool search; published 2025-09-16)                            |
| Prometheus         | `prom/prometheus:v3.15.0` (optional, `monitoring.enabled`; pushed 2026-09-25) |
| MCP Inspector      | 2.9.0 (OAuth check; published 2026-09-30; verified over https on the VM)      |
