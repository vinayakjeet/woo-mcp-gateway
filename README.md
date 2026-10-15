# woo-mcp-gateway

> DRAFT (M7). This README will be rewritten in M14. The commands were checked on the local k3d setup on 2026-10-12.

WooCommerce stores on Kubernetes, our own WooCommerce MCP server, a team MCP gateway with a React dashboard, and a chat agent. One gateway URL and one personal API key give an MCP client the tools of every enabled server.

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

From a terminal: `pnpm tsx scripts/mcp-smoke.ts http://mcp.127.0.0.1.nip.io/mcp <key> [tool] [json args]`.

## Use the chat agent

Open http://app.127.0.0.1.nip.io/chat. The agent calls the gateway as the signed-in user, so it sees that user's tools and every call lands in the audit log with via `agent`. Each tool call shows as a chip with its arguments and duration; open it for the result. History stays in the browser, per user.

Prompts for a demo:

- "How many orders today?" (`main__get_info`, or `main__list_orders` with `date: today`)
- "Create a product called Ginger Tea 100g priced at 180." Then refresh the storefront.
- "Total sales today in USD." (main and fx)
- "Open an issue in store-ops listing today's on-hold orders." (main and gh)

Models (`deploy/values-local.yaml`): primary `gemini-3.5-flash-lite`, fallback `openai/gpt-oss-120b` on Groq. Free tiers answer 429 or 503 in bursts. The agent retries the primary once, then uses the fallback, and when both are limited it says so with the wait in seconds.

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
```

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
