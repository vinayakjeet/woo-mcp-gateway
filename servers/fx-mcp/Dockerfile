FROM node:24-alpine AS build
# Low by default: the local network drops more than about 4 concurrent connections. CI can raise it.
ARG PNPM_NETWORK_CONCURRENCY=4
RUN npm install -g pnpm@10.34.6
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --network-concurrency "$PNPM_NETWORK_CONCURRENCY" \
 && pnpm --filter @woo/fx-mcp... build \
 && pnpm --filter @woo/fx-mcp deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER 10001
EXPOSE 8080
CMD ["node", "dist/index.js"]
