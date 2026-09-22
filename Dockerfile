# syntax=docker/dockerfile:1

# The browser UI. Built in its own stage so its dependency tree never enters the runtime image and
# its lockfile stays independent of the service's. The shared API types live in the Nest tree, one
# level up from web/, which is what the extra COPY is for.
FROM node:22-alpine AS web
WORKDIR /app/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ui-api/api-types.ts /app/src/ui-api/api-types.ts
COPY web/ ./
RUN pnpm build

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
# The UI bundle, served by express.static from main.ts when this directory exists.
COPY --from=web /app/web/dist ./web/dist
# tini reaps zombies and forwards SIGTERM, so Nest's shutdown hooks actually fire on redeploy.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
