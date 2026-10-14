FROM node:24-alpine AS build
# Low by default: the local network drops more than about 4 concurrent connections. CI can raise it.
ARG PNPM_NETWORK_CONCURRENCY=4
RUN npm install -g pnpm@10.34.6
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --network-concurrency "$PNPM_NETWORK_CONCURRENCY" \
 && pnpm --filter @woo/control-plane... build \
 && pnpm --filter @woo/control-plane deploy --prod --legacy /out

# The provisioner runs the helm CLI (SPEC 18). The tarball is checked against a pinned digest.
FROM node:24-alpine AS helm
ARG TARGETARCH
ARG HELM_VERSION=4.3.0
# From https://get.helm.sh/helm-v4.3.0-linux-<arch>.tar.gz.sha256sum, fetched 2026-10-13.
ARG HELM_SHA256_AMD64=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb
ARG HELM_SHA256_ARM64=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sum="$HELM_SHA256_AMD64" ;; \
      arm64) sum="$HELM_SHA256_ARM64" ;; \
      *) echo "no pinned helm digest for $arch" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${arch}.tar.gz"; \
    echo "$sum  /tmp/helm.tgz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    install -m 0755 "/tmp/linux-${arch}/helm" /usr/local/bin/helm

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
# Baked in so an install never fetches a chart at run time (SPEC 18).
COPY charts/store /charts/store
USER 10001
EXPOSE 3000 3001
CMD ["node", "dist/index.js"]
