#!/usr/bin/env bash
# Deploy Scarab to Cloud Run. After bootstrap, this is the only command you need:
#   ./scripts/deploy.sh
# Reads .env.gcp (written by bootstrap-gcp.sh) unless PROJECT_ID etc. are already set.
set -euo pipefail

if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp
fi
: "${PROJECT_ID:?PROJECT_ID not set — run scripts/bootstrap-gcp.sh first}"
: "${REGION:?REGION not set}"
: "${BUCKET:?BUCKET not set}"
: "${SA_EMAIL:?SA_EMAIL not set}"

# Vault-only (zero-knowledge) deployment: set SCARAB_ZK_ONLY=1 (put it in
# .env.gcp so it sticks — --set-env-vars replaces the whole env each deploy).
# The server then answers only the ciphertext courier (with its kept versions,
# members and invitations) and the price basket with its monthly history —
# the complete list is server/zk-routes.ts.
# Turning a household install into a vault-only one is a one-time
# SCARAB_PURGE_PLAINTEXT=1 alongside it; the server refuses to boot ZK-only
# over plaintext without it. Export your data first.
ENV_VARS="LITESTREAM_BUCKET=${BUCKET}"
[[ -n "${SCARAB_ZK_ONLY:-}" ]] && ENV_VARS="${ENV_VARS},SCARAB_ZK_ONLY=${SCARAB_ZK_ONLY}"
[[ -n "${SCARAB_PURGE_PLAINTEXT:-}" ]] && ENV_VARS="${ENV_VARS},SCARAB_PURGE_PLAINTEXT=${SCARAB_PURGE_PLAINTEXT}"

# --max-instances 1 is load-bearing: SQLite has one writer, so there must be
# exactly one container. Two users will never notice.
gcloud beta run deploy scarab \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --iap \
  --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" \
  --set-env-vars "${ENV_VARS}" \
  --max-instances 1 \
  --min-instances 0 \
  --memory 512Mi
