#!/usr/bin/env bash
# One-time GCP setup for Scarab. Run this after you have:
#   1. Created a GCP project in the console (console.cloud.google.com)
#   2. Attached a billing account to it
#   3. Installed gcloud and run: gcloud auth login
#
# Usage:
#   ./scripts/bootstrap-gcp.sh <PROJECT_ID> <your@gmail.com> <spouse@gmail.com>
#   ./scripts/bootstrap-gcp.sh trust-chain      # only the release/CI part, on an install that predates it (reads .env.gcp)
#
# Everything here sits in free tiers at 2-user scale. The IAP allowlist is the
# security boundary: only the two accounts you pass in can reach the app at all.
set -euo pipefail

SERVICE="scarab"

# ---------------------------------------------------------------------------
# Trust chain: GitHub Actions builds and attests release images, a human deploys them.
#
# .github/workflows/release.yml signs in to this project through Workload
# Identity Federation: GitHub's OIDC token for a run *of this repository* is
# exchanged for a short-lived token of the scarab-ci service account. No key
# file is created and nothing is stored on GitHub but four plain variables.
# That account may do exactly one thing — push images to the scarab Artifact
# Registry repository. It cannot deploy, read the Litestream bucket or touch
# IAP: deploying stays scripts/deploy.sh on a laptop, under your own account,
# after `gh attestation verify` has checked the image.
#
# It also creates scarab-verify, a service account on the IAP allowlist that
# scripts/verify-served.sh fetches the site as. IAP in front of Cloud Run uses
# a Google-managed OAuth client, and with one of those IAP takes no
# programmatic clients at all (and a personal project has no organization to
# own one) — but it accepts a service account's short-lived self-signed JWT.
# Only an account allowed to sign as scarab-verify can use it: yours, granted
# here on that one account. So this adds one identity that the operator
# already is, and widens nothing.
#
# Idempotent — every step tolerates "already exists".
# ---------------------------------------------------------------------------
# A service account that was created a moment ago is not yet visible to IAM
# everywhere, sometimes for a few minutes: a binding that names it fails with
# "does not exist", and setting the account's own policy fails with
# PERMISSION_DENIED "… denied on resource (or it may not exist)" — IAM's way of
# not saying whether a resource exists. Retry either for up to two minutes;
# any other error is final. (A real denial on an Owner's account is not this;
# if the retries run out, check the active account's role on the project —
# Owner, or Service Account Admin plus Artifact Registry Admin.)
bind_with_retry() { # <gcloud … add-iam-policy-binding …>
  local attempt out
  for attempt in $(seq 1 12); do
    if out=$("$@" 2>&1); then return 0; fi
    if [[ $attempt -lt 12 && "$out" == *"not exist"* ]]; then
      echo "    (IAM hasn't seen the new service account yet — retrying in 10s, attempt ${attempt}/12)"
      sleep 10
    else
      echo "$out" >&2
      return 1
    fi
  done
}

setup_trust_chain() { # uses PROJECT_ID, REGION; GITHUB_REPO (owner/name) or the origin remote
  local repo="${GITHUB_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')}"
  [[ "$repo" == */* ]] || { echo "Set GITHUB_REPO=owner/name (couldn't read it from the origin remote)" >&2; exit 1; }
  local number ci_sa pool provider
  number=$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')
  ci_sa="scarab-ci@${PROJECT_ID}.iam.gserviceaccount.com"
  pool="github"
  provider="projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/github"

  echo "==> Trust chain for github.com/${repo}: enabling APIs"
  gcloud services enable iamcredentials.googleapis.com sts.googleapis.com artifactregistry.googleapis.com iap.googleapis.com --project "$PROJECT_ID"

  echo "==> Artifact Registry repository for release images"
  gcloud artifacts repositories create scarab --project "$PROJECT_ID" --location "$REGION" \
    --repository-format docker --description "Scarab release images, built and attested by GitHub Actions" \
    || echo "    (repository already exists — fine)"

  echo "==> The CI service account: may push images, nothing else"
  gcloud iam service-accounts create scarab-ci --project "$PROJECT_ID" --display-name "Scarab CI (GitHub Actions: push release images)" \
    || echo "    (service account already exists — fine)"
  bind_with_retry gcloud artifacts repositories add-iam-policy-binding scarab --project "$PROJECT_ID" --location "$REGION" \
    --member "serviceAccount:${ci_sa}" --role roles/artifactregistry.writer

  echo "==> Workload Identity Federation: GitHub's OIDC issuer, trusted for runs of ${repo} only"
  gcloud iam workload-identity-pools create "$pool" --project "$PROJECT_ID" --location global --display-name "GitHub Actions" \
    || echo "    (pool already exists — fine)"
  gcloud iam workload-identity-pools providers create-oidc github --project "$PROJECT_ID" --location global \
    --workload-identity-pool "$pool" --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${repo}'" \
    || echo "    (provider already exists — fine)"
  # Only this repository's runs may become scarab-ci (a fork's runs carry a different assertion.repository).
  bind_with_retry gcloud iam service-accounts add-iam-policy-binding "$ci_sa" --project "$PROJECT_ID" \
    --role roles/iam.workloadIdentityUser \
    --member "principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.repository/${repo}"

  echo "==> The verifier: scarab-verify may fetch the site through IAP, and only you may sign as it"
  local verify_sa me
  verify_sa="scarab-verify@${PROJECT_ID}.iam.gserviceaccount.com"
  me=$(gcloud config get-value account 2>/dev/null)
  [[ -n "$me" ]] || { echo "gcloud has no active account — gcloud auth login first" >&2; exit 1; }
  gcloud iam service-accounts create scarab-verify --project "$PROJECT_ID" \
    --display-name "Scarab verifier (fetches the site through IAP for scripts/verify-served.sh)" \
    || echo "    (service account already exists — fine)"
  # On the site's allowlist like a member: IAP lets it through, the app sees it as an identity like any other.
  bind_with_retry gcloud beta iap web add-iam-policy-binding --project "$PROJECT_ID" --region "$REGION" \
    --resource-type=cloud-run --service="$SERVICE" --member "serviceAccount:${verify_sa}" --role roles/iap.httpsResourceAccessor
  # Signing as it (gcloud iam service-accounts sign-jwt) is granted to this one account, on this one service account.
  bind_with_retry gcloud iam service-accounts add-iam-policy-binding "$verify_sa" --project "$PROJECT_ID" \
    --member "user:${me}" --role roles/iam.serviceAccountTokenCreator

  echo "==> Recording the repository in .env.gcp"
  if [[ -f .env.gcp ]] && ! grep -q '^REPO=' .env.gcp; then echo "REPO=${repo}" >> .env.gcp; fi

  echo
  echo "GitHub repository variables for .github/workflows/release.yml (none is a secret):"
  echo "  GCP_PROJECT_ID      ${PROJECT_ID}"
  echo "  GCP_REGION          ${REGION}"
  echo "  WIF_PROVIDER        ${provider}"
  echo "  WIF_SERVICE_ACCOUNT ${ci_sa}"
  if command -v gh >/dev/null; then
    echo "==> Setting them with gh"
    gh variable set GCP_PROJECT_ID --repo "$repo" --body "$PROJECT_ID"
    gh variable set GCP_REGION --repo "$repo" --body "$REGION"
    gh variable set WIF_PROVIDER --repo "$repo" --body "$provider"
    gh variable set WIF_SERVICE_ACCOUNT --repo "$repo" --body "$ci_sa"
  else
    echo "Set them at https://github.com/${repo}/settings/variables/actions (or install gh and rerun: ./scripts/bootstrap-gcp.sh trust-chain)."
  fi
  echo
  echo "Then: git tag v0.1.0 && git push origin v0.1.0 → the workflow builds, attests and publishes the release;"
  echo "      ./scripts/deploy.sh v0.1.0 verifies and deploys it; ./scripts/verify-served.sh checks the site against it."
}

if [[ "${1:-}" == "trust-chain" ]]; then
  if [[ -f .env.gcp ]]; then
    # shellcheck disable=SC1091
    source .env.gcp
  fi
  : "${PROJECT_ID:?PROJECT_ID not set — run the full bootstrap first, or export it}"
  REGION="${REGION:-us-west1}"
  setup_trust_chain
  exit 0
fi

PROJECT_ID="${1:?usage: bootstrap-gcp.sh <PROJECT_ID> <user1-email> <user2-email> | bootstrap-gcp.sh trust-chain}"
USER1="${2:?missing first user email}"
USER2="${3:?missing second user email}"
REGION="${REGION:-us-west1}"
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

echo "==> First deploy (from source, with Cloud Build: no release exists yet, so nothing to attest — see deploy.sh)"
REGION="$REGION" PROJECT_ID="$PROJECT_ID" BUCKET="$BUCKET" SA_EMAIL="$SA_EMAIL" ./scripts/deploy.sh --source

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

setup_trust_chain

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
