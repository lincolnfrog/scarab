# Build stage: install everything, build client + server, then strip dev deps.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime: slim node + litestream for continuous SQLite replication to GCS.
FROM node:22-slim
WORKDIR /app

# node:slim has no system CA store (node bundles its own roots, Go binaries
# like litestream don't) — without this, litestream fails TLS to GCS on boot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin && rm /tmp/litestream.tar.gz

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json litestream.yml entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
ENV DB_PATH=/data/scarab.db
EXPOSE 8080
CMD ["./entrypoint.sh"]
