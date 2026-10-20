#!/usr/bin/env bash
# One-time: the identity the scheduled market-history crawl runs as.
#
#   ./scripts/history-sa.sh            # reads PROJECT_ID and REGION from .env.gcp
#
# .github/workflows/history.yml calls POST /api/basket/crawl on scarab.one a
# few times a day so the market-history build gets CPU on Cloud Run (see the
# workflow's header, and DESIGN.md §6 "Cloud Run CPU"). To get through IAP it
# needs an identity on the site's allowlist, and IAP's Google-managed OAuth
# client accepts no programmatic clients — only a service account's self-signed
# JWT. So, modelled on the verifier in bootstrap-gcp.sh (scarab-verify), this
# creates:
#
#   scarab-history   a service account on the IAP allowlist like a member. The
#                    app sees it as an identity like any other; it owns no vault
#                    and asks only for the crawl, which carries no household
#                    data in either direction (PRIVACY.md).
#
# and grants scarab-ci — the release workflow's identity, which GitHub's runs
# of this repository become through Workload Identity Federation — the right
# to sign JWTs as scarab-history (roles/iam.serviceAccountTokenCreator on that
# one account). Nothing else changes: scarab-ci still can't deploy, read the
# bucket or touch IAP, and no key is created anywhere.
#
# Idempotent — every step tolerates "already exists". Does not touch
# bootstrap-gcp.sh's own steps; run it once on an install that has run
# `bootstrap-gcp.sh trust-chain`.
set -euo pipefail

if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp
fi
: "${PROJECT_ID:?PROJECT_ID not set — run scripts/bootstrap-gcp.sh first (it writes .env.gcp)}"
: "${REGION:?REGION not set}"
SERVICE="${SERVICE:-scarab}"

history_sa="scarab-history@${PROJECT_ID}.iam.gserviceaccount.com"
ci_sa="scarab-ci@${PROJECT_ID}.iam.gserviceaccount.com"

# As in bootstrap-gcp.sh: a service account created a moment ago is not yet
# visible to IAM everywhere; a binding that names it fails with "does not
# exist" (or "(or it may not exist)") for up to a few minutes. Retry those.
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

gcloud iam service-accounts describe "$ci_sa" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || { echo "${ci_sa} does not exist — run ./scripts/bootstrap-gcp.sh trust-chain first (it creates the CI identity and Workload Identity Federation)." >&2; exit 1; }

echo "==> scarab-history: the identity the scheduled crawl calls the site as"
gcloud iam service-accounts create scarab-history --project "$PROJECT_ID" \
  --display-name "Scarab history crawl (GitHub Actions: POST /api/basket/crawl through IAP)" \
  || echo "    (service account already exists — fine)"

echo "==> On the site's IAP allowlist, like a member"
bind_with_retry gcloud beta iap web add-iam-policy-binding --project "$PROJECT_ID" --region "$REGION" \
  --resource-type=cloud-run --service="$SERVICE" --member "serviceAccount:${history_sa}" --role roles/iap.httpsResourceAccessor

echo "==> scarab-ci may sign JWTs as it (and only that)"
bind_with_retry gcloud iam service-accounts add-iam-policy-binding "$history_sa" --project "$PROJECT_ID" \
  --member "serviceAccount:${ci_sa}" --role roles/iam.serviceAccountTokenCreator

echo
echo "Done. .github/workflows/history.yml derives the account from the GCP_PROJECT_ID repository variable"
echo "(${history_sa}) and signs in through the WIF_PROVIDER / WIF_SERVICE_ACCOUNT variables release.yml"
echo "already uses. Set SCARAB_ORIGIN only if the site is not https://scarab.one."
echo "Try it now: Actions → Market history → Run workflow; or by hand, as yourself:"
echo "  gcloud iam service-accounts sign-jwt --iam-account ${history_sa} claim.json token.jwt   # needs tokenCreator on it, as for scarab-verify"
