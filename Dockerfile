FROM node:22-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile || true

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY --from=deps /app/node_modules ./node_modules
COPY .env .env
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
RUN mkdir -p .next/standalone .next/static public

FROM node:22-alpine AS migrate
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db ./src/db
CMD ["pnpm", "dlx", "drizzle-kit", "migrate"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", ".next/standalone/server.js"]
