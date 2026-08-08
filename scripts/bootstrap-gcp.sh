#!/usr/bin/env bash
# One-time GCP setup for Scarab. Run this after you have:
#   1. Created a GCP project in the console (console.cloud.google.com)
#   2. Attached a billing account to it
#   3. Installed gcloud and run: gcloud auth login
#
# Usage:
#   ./scripts/bootstrap-gcp.sh <PROJECT_ID> <your@gmail.com> <spouse@gmail.com>
#
# Everything here sits in free tiers at 2-user scale. The IAP allowlist is the
# security boundary: only the two accounts you pass in can reach the app at all.
set -euo pipefail

PROJECT_ID="${1:?usage: bootstrap-gcp.sh <PROJECT_ID> <user1-email> <user2-email>}"
USER1="${2:?missing first user email}"
USER2="${3:?missing second user email}"
REGION="${REGION:-us-west1}"
SERVICE="scarab"
BUCKET="${PROJECT_ID}-scarab-litestream"
SA_NAME="scarab-run"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Enabling APIs (this can take a minute)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iap.googleapis.com \
  storage.googleapis.com \
  --project "$PROJECT_ID"

echo "==> Creating the Litestream bucket (private; holds continuous DB backups)"
gcloud storage buckets create "gs://${BUCKET}" \
  --project "$PROJECT_ID" --location "$REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  || echo "    (bucket already exists — fine)"

echo "==> Creating the runtime service account"
gcloud iam service-accounts create "$SA_NAME" \
  --project "$PROJECT_ID" --display-name "Scarab Cloud Run runtime" \
  || echo "    (service account already exists — fine)"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin

echo "==> First deploy (builds remotely with Cloud Build; no local Docker needed)"
REGION="$REGION" PROJECT_ID="$PROJECT_ID" BUCKET="$BUCKET" SA_EMAIL="$SA_EMAIL" ./scripts/deploy.sh

echo "==> Allowlisting exactly two humans on IAP"
for u in "$USER1" "$USER2"; do
  gcloud beta iap web add-iam-policy-binding \
    --project "$PROJECT_ID" --region "$REGION" \
    --resource-type=cloud-run --service="$SERVICE" \
    --member="user:${u}" --role=roles/iap.httpsResourceAccessor
done

echo "==> Saving deploy config to .env.gcp (gitignored)"
cat > .env.gcp <<EOF
PROJECT_ID=${PROJECT_ID}
REGION=${REGION}
BUCKET=${BUCKET}
SA_EMAIL=${SA_EMAIL}
EOF

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')
echo
echo "Done. Scarab is at: ${URL}"
echo
echo "NOTE: in a project outside a Google Workspace Organization, IAP's OAuth"
echo "client can only be provisioned once via the console. If the URL above"
echo "returns 502 'Empty Google Account OAuth client', open:"
echo "  https://console.cloud.google.com/run/detail/${REGION}/${SERVICE}/security?project=${PROJECT_ID}"
echo "and complete the Identity-Aware Proxy setup there (one time only)."
echo
echo "Checklist:"
echo "  [ ] Open it as ${USER1} — you should see the shell with 'signed in as' your email"
echo "  [ ] Have ${USER2} open it — same"
echo "  [ ] Try an incognito window / third account — IAP must refuse it"
