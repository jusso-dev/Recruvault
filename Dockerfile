FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS migration-deps
COPY scripts/package-runtime-tools.mjs ./scripts/package-runtime-tools.mjs
RUN node scripts/package-runtime-tools.mjs /app /runtime-tools

FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
ARG TRUSTED_DOMAINS=localhost
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 TRUSTED_DOMAINS=${TRUSTED_DOMAINS}
RUN npm run build

FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS runtime-base
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# The standalone server needs Node, but no package manager at runtime.
# Patch the base OS and remove unused package-manager dependency trees.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /opt/yarn-v* /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack
RUN addgroup -S app && adduser -S app -G app

# Applies migrations, then the idempotent reference-data seed. Either failure
# exits non-zero, so the app (which waits on this service) never starts.
FROM runtime-base AS migrate
COPY --from=migration-deps /runtime-tools/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY src/db ./src/db
COPY src/lib/fields.ts ./src/lib/fields.ts
USER app
CMD ["sh", "-ec", "node node_modules/drizzle-kit/bin.cjs migrate && node node_modules/tsx/dist/cli.mjs src/db/seed.ts"]

FROM runtime-base AS runner
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Application files stay root-owned and read-only to the app user. Only the
# Next.js cache directory is writable (mounted as tmpfs in production compose).
RUN mkdir -p .next/cache && chown app:app .next/cache
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Docker sets HOSTNAME to the container id, and the standalone server treats
# that value as its listen address. Force all interfaces or the health check
# cannot connect to 127.0.0.1.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
