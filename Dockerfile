FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS migration-deps
COPY scripts/package-runtime-tools.mjs ./scripts/package-runtime-tools.mjs
RUN node scripts/package-runtime-tools.mjs /app /runtime-tools

FROM node:22-alpine AS build
ARG TRUSTED_DOMAINS=localhost
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 TRUSTED_DOMAINS=${TRUSTED_DOMAINS}
RUN npm run build

FROM node:22-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# The standalone server needs Node, but no package manager at runtime.
# Patch the base OS and remove unused package-manager dependency trees.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /opt/yarn-v* /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack
RUN addgroup -S app && adduser -S app -G app

FROM runtime-base AS migrate
COPY --from=migration-deps /runtime-tools/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db ./src/db
USER app
CMD ["node", "node_modules/drizzle-kit/bin.cjs", "migrate"]

FROM runtime-base AS runner
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "server.js"]
