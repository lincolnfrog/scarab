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

# --max-instances 1 is load-bearing: SQLite has one writer, so there must be
# exactly one container. Two users will never notice.
gcloud beta run deploy scarab \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --iap \
  --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" \
  --set-env-vars "LITESTREAM_BUCKET=${BUCKET}" \
  --max-instances 1 \
  --min-instances 0 \
  --memory 512Mi
