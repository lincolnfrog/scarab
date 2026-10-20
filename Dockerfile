# Base images are pinned by digest, not tag, so the same Dockerfile builds the
# same image next month: the release workflow attests this image, and a tag
# that moved underneath it would make the attestation describe something else.
# The digests are the multi-arch index digests of node:22 and node:22-slim.
# To bump (after a Node security release, or when `node:22` has moved on):
#   docker buildx imagetools inspect node:22      --format '{{.Manifest.Digest}}'
#   docker buildx imagetools inspect node:22-slim --format '{{.Manifest.Digest}}'
# or, without Docker, read "Docker-Content-Digest" from the registry:
#   T=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $T" -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/22 | grep -i docker-content-digest
# Paste the new digests below, keep the comment's date, and push to main: the
# workflow's dry run rebuilds and re-checks reproducibility before any tag.
# Pinned 2026-10-19 (node:22 image built 2026-10-06).

# Build stage: install everything, build client + server, then strip dev deps.
FROM node:22@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 AS build
WORKDIR /app
# Provenance for dist/build.json (scripts/build-manifest.mjs). The release
# workflow passes the commit, tag and repository; a plain `docker build` or a
# `gcloud run deploy --source` leaves them empty, and the manifest says so
# (null) rather than guessing — there is no .git in the build context.
ARG SCARAB_COMMIT=
ARG SCARAB_TAG=
ARG SCARAB_REPO=
ENV SCARAB_COMMIT=$SCARAB_COMMIT SCARAB_TAG=$SCARAB_TAG SCARAB_REPO=$SCARAB_REPO
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime: slim node + litestream for continuous SQLite replication to GCS.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app

# node:slim has no system CA store (node bundles its own roots, Go binaries
# like litestream don't) — without this, litestream fails TLS to GCS on boot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Litestream, pinned by the release tarball's sha256 (a plain sha256sum check
# rather than ADD --checksum, which needs BuildKit — Cloud Build's `--source`
# path may not have it). To bump: new URL, `curl -sL <url> | sha256sum`.
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN echo "eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0  /tmp/litestream.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin && rm /tmp/litestream.tar.gz

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# seed/ holds the prebuilt market history when one was built (npm run seed:history); else just .gitkeep.
COPY --from=build /app/seed ./seed
COPY package.json litestream.yml entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
ENV DB_PATH=/data/scarab.db
EXPOSE 8080
CMD ["./entrypoint.sh"]
