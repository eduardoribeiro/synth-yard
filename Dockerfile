# syntax=docker/dockerfile:1

# Use the same Node and pnpm versions as local development and CI.
FROM node:26.8.1-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.3.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY patches ./patches

# Native pnpm patches apply during both development and production installs.
FROM base AS deps
RUN pnpm install --frozen-lockfile

FROM base AS server-deps
RUN pnpm --filter synth-yard install --prod --frozen-lockfile

FROM deps AS client-build
COPY client/ ./client/
RUN pnpm build

FROM node:26.8.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
# Copy the complete virtual store as well as the relative dependency symlinks.
COPY --from=server-deps /app/node_modules ./node_modules
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p server/data server/gcode
EXPOSE 3000
CMD ["node", "server/index.js"]

# Source is bind-mounted by docker-compose; dependency volumes use Linux builds.
FROM deps AS dev
EXPOSE 3000 5173
CMD ["sh", "-c", "([ -f client/dist/index.html ] || pnpm build) && pnpm dev"]
