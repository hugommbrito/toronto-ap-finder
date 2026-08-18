# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Migrations run at boot; the seed files make a cold start work without any network call.
COPY src/db/migrations ./src/db/migrations
COPY data/seed ./data/seed
# tini reaps zombies and forwards SIGTERM, so Nest's shutdown hooks actually fire on redeploy.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
