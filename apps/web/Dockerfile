FROM node:24-alpine AS build
# Low by default: the local network drops more than about 4 concurrent connections. CI can raise it.
ARG PNPM_NETWORK_CONCURRENCY=4
RUN npm install -g pnpm@10.34.6
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --network-concurrency "$PNPM_NETWORK_CONCURRENCY" \
 && pnpm --filter @woo/web build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
