FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @woo/gateway... build \
 && pnpm --filter @woo/gateway deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER 10001
EXPOSE 8080 9090
CMD ["node", "dist/index.js"]
