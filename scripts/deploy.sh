#!/usr/bin/env bash
# Deploy Scarab to Cloud Run — the attested image of a release, by digest.
#
#   ./scripts/deploy.sh                 # the latest GitHub release
#   ./scripts/deploy.sh v0.4.0          # that release
#   ./scripts/deploy.sh sha256:…        # an exact image digest (still verified)
#   ./scripts/deploy.sh --source        # fallback: Cloud Build from this checkout, unattested (below)
#
# Reads .env.gcp (written by bootstrap-gcp.sh) unless PROJECT_ID etc. are already set.
#
# What "attested" buys: the image was built by .github/workflows/release.yml
# from a public commit of the tagged release, on GitHub's runners, and Sigstore
# signed that claim. `gh attestation verify` checks the signature and this
# script checks the claim names this tag and this workflow — so the thing that
# goes live is, provably, the thing the repository says it is, and anyone can
# later hold scarab.one to it (scripts/verify-served.sh). Needs the GitHub CLI
# (`brew install gh`, `gh auth login`) and jq.
#
# --source is the old path (`gcloud run deploy --source .`): Cloud Build builds
# whatever is in this directory and nothing signs it; the served build.json
# then has commit: null and the Data & Vault screen says so. It stays for the
# first deploy of a fresh project (bootstrap runs it before any release exists)
# and for a fork without CI. It is never the right way to update scarab.one.
set -euo pipefail

if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp
fi
: "${PROJECT_ID:?PROJECT_ID not set — run scripts/bootstrap-gcp.sh first}"
: "${REGION:?REGION not set}"
: "${BUCKET:?BUCKET not set}"
: "${SA_EMAIL:?SA_EMAIL not set}"
REPO="${REPO:-lincolnfrog/scarab}"                                    # GitHub owner/name; bootstrap writes it to .env.gcp
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/scarab/scarab}" # Artifact Registry (bootstrap-gcp.sh trust-chain)
WORKFLOW="${REPO}/.github/workflows/release.yml"

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
deploy() { # <--image X | --source .>
  gcloud beta run deploy scarab \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    "$@" \
    --iap \
    --no-allow-unauthenticated \
    --service-account "$SA_EMAIL" \
    --set-env-vars "${ENV_VARS}" \
    --max-instances 1 \
    --min-instances 0 \
    --memory 512Mi
}

what="${1:-}"
if [[ "$what" == "--source" ]]; then
  echo "==> Source deploy (unattested): Cloud Build from $(pwd)"
  deploy --source .
  exit 0
fi

# ---- which image ----
TAG=""
DIGEST=""
case "$what" in
  sha256:*) DIGEST="$what" ;;
  v*) TAG="$what" ;;
  "")
    TAG=$(curl -fsS "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name // empty')
    [[ -n "$TAG" ]] || { echo "No release found at github.com/${REPO} — tag one (git tag v0.1.0 && git push --tags) or pass a digest." >&2; exit 1; }
    echo "==> Latest release: $TAG"
    ;;
  *) echo "usage: $0 [vX.Y.Z | sha256:<digest> | --source]" >&2; exit 2 ;;
esac
if [[ -n "$TAG" ]]; then
  # The tag in Artifact Registry is a convenience; the digest is what gets deployed and verified.
  DIGEST=$(gcloud artifacts docker images describe "${IMAGE}:${TAG}" --project "$PROJECT_ID" --format 'value(image_summary.digest)' 2>/dev/null || true)
  [[ "$DIGEST" == sha256:* ]] || { echo "No image ${IMAGE}:${TAG} — did the release workflow for ${TAG} succeed? (github.com/${REPO}/actions)" >&2; exit 1; }
fi
echo "==> Image: ${IMAGE}@${DIGEST}"

# ---- verify its attestation ----
if [[ -n "${SCARAB_UNVERIFIED:-}" ]]; then
  echo "!!  SCARAB_UNVERIFIED is set: deploying without checking the attestation."
else
  command -v gh >/dev/null || { echo "The GitHub CLI is needed to verify the image's attestation: brew install gh && gh auth login (or SCARAB_UNVERIFIED=1 to skip, and know why)." >&2; exit 1; }
  command -v jq >/dev/null || { echo "jq is needed to read the attestation." >&2; exit 1; }
  # gh reads the registry through the Docker credential helper gcloud installs (no Docker daemon needed).
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1
  verify=$(mktemp)
  trap 'rm -f "$verify"' EXIT
  gh attestation verify "oci://${IMAGE}@${DIGEST}" --repo "$REPO" --signer-workflow "$WORKFLOW" --format json > "$verify"
  ref=$(jq -r '.[0].verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.ref' "$verify")
  commit=$(jq -r '.[0].verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit' "$verify")
  if [[ -n "$TAG" && "$ref" != "refs/tags/${TAG}" ]]; then
    echo "The attestation says this image was built from ${ref}, not refs/tags/${TAG} — refusing." >&2
    exit 1
  fi
  echo "==> Attested: built by ${WORKFLOW} from ${ref} @ ${commit:0:7} (github.com/${REPO}/commit/${commit})"
fi

deploy --image "${IMAGE}@${DIGEST}"
echo
echo "Deployed ${IMAGE}@${DIGEST}${TAG:+ ($TAG)}."
echo "Check what is served: ./scripts/verify-served.sh${TAG:+ --tag $TAG}"
