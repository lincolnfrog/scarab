#!/usr/bin/env bash
# Open scarab.one to every Google account — or close it again.
#
#   ./scripts/open-signup.sh            # show IAP's current policy, and what each flag would do
#   ./scripts/open-signup.sh --open     # any Google account may sign in and create its own vault
#   ./scripts/open-signup.sh --close    # back to the allowlist alone
#
# Reads PROJECT_ID and REGION from .env.gcp (written by bootstrap-gcp.sh), like
# deploy.sh. Run by hand, by the operator, with gcloud signed in as an owner of
# the project. Nothing here deploys or changes the service; it edits one IAM
# binding on the IAP resource in front of it.
#
# What opening means. Identity-Aware Proxy lets a request through when the
# caller holds roles/iap.httpsResourceAccessor on the Cloud Run service.
# bootstrap-gcp.sh grants it to two humans and to the verifier service account
# (scarab-verify). --open grants it to `allAuthenticatedUsers` as well: every
# Google account in the world can then sign in, and the server — vault-only,
# SCARAB_ZK_ONLY=1 — gives each new identity an empty front door where it
# creates its own vault (ciphertext the server cannot read; PRIVACY.md), joins
# a household that invited it, or leaves. The two-person allowlist stays in the
# policy as a harmless subset, and so does the verifier; --close removes only
# the allAuthenticatedUsers binding, so the household and the verifier keep
# getting in. Propagation takes up to a minute or two either way.
#
# What the server and IAP then learn, and the rest of the honest accounting,
# is PRIVACY.md → "Open sign-up". The terms and privacy pages the front door
# links to (public/terms.html, public/privacy.html) carry an OPERATOR_CONTACT
# placeholder: fill it before opening.
#
# The OAuth consent screen. IAP in front of Cloud Run signs people in through
# the project's OAuth consent screen (Google Auth Platform). When that screen's
# publishing status is "Testing", Google may refuse any account that is not a
# listed test user, however the IAP policy reads — the sign-in page then says
# the app has not completed verification, or that access is blocked. For
# strangers to get in it may have to be "In production" with user type
# "External". This script cannot check that (there is no gcloud surface for
# it); look at
#   https://console.cloud.google.com/auth/audience?project=<PROJECT_ID>
# (formerly APIs & Services → OAuth consent screen) and, if it says Testing,
# publish it. An app with sensitive scopes would then need Google's review;
# sign-in alone (openid, email) does not. Whether a Google-managed IAP client
# is subject to this at all is something the operator has to see for
# themselves with an account outside the project — this script says so rather
# than guessing.
set -euo pipefail

SERVICE="scarab"
ROLE="roles/iap.httpsResourceAccessor"
MEMBER="allAuthenticatedUsers"

if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp
fi
: "${PROJECT_ID:?PROJECT_ID not set — run scripts/bootstrap-gcp.sh first, or export it}"
: "${REGION:?REGION not set}"

command -v gcloud >/dev/null || { echo "needs gcloud (https://cloud.google.com/sdk), signed in as an owner of ${PROJECT_ID}" >&2; exit 1; }

# The IAP resource is the Cloud Run service, addressed as bootstrap-gcp.sh addresses it for people.
iap() { gcloud beta iap web "$@" --project "$PROJECT_ID" --region "$REGION" --resource-type=cloud-run --service="$SERVICE"; }

# Is allAuthenticatedUsers on the policy right now? Prints "open" or "closed" (the policy itself goes to stderr when asked).
state() { # [--show]
  local policy
  policy=$(iap get-iam-policy --format=json)
  if [[ "${1:-}" == "--show" ]]; then
    echo "IAP policy on Cloud Run service '${SERVICE}' (${PROJECT_ID}, ${REGION}):" >&2
    if command -v jq >/dev/null; then
      jq -r '.bindings[]? | "  \(.role)" , (.members[] | "    \(.)")' <<<"$policy" >&2
    else
      echo "$policy" >&2
    fi
  fi
  if grep -q "\"${MEMBER}\"" <<<"$policy"; then echo open; else echo closed; fi
}

case "${1:-}" in
  "")
    now=$(state --show)
    echo
    if [[ "$now" == open ]]; then
      echo "Sign-up is OPEN: ${MEMBER} holds ${ROLE}, so any Google account can sign in and create a vault."
      echo "  --close removes that binding; the people and service accounts listed above keep their access."
    else
      echo "Sign-up is CLOSED: only the identities listed above get past IAP."
      echo "  --open adds ${MEMBER} with ${ROLE}: every Google account may then sign in and create its own vault."
      echo "  Before that: fill OPERATOR_CONTACT in public/terms.html and public/privacy.html, release and deploy, and"
      echo "  check the OAuth consent screen's publishing status (see the header of this script)."
    fi
    ;;
  --open)
    if [[ "$(state)" == open ]]; then echo "Already open: ${MEMBER} holds ${ROLE}."; exit 0; fi
    echo "This lets EVERY Google account sign in to ${SERVICE} (${PROJECT_ID}) and create its own vault."
    read -r -p "Open sign-up? [y/N] " answer
    [[ "$answer" == [yY]* ]] || { echo "Left closed."; exit 0; }
    iap add-iam-policy-binding --member="$MEMBER" --role="$ROLE" >/dev/null
    echo "Open. The binding takes a minute or two to propagate."
    echo "Try it with a Google account outside the allowlist — if Google's sign-in page refuses it, the OAuth consent"
    echo "screen is probably still in Testing: https://console.cloud.google.com/auth/audience?project=${PROJECT_ID}"
    ;;
  --close)
    if [[ "$(state)" == closed ]]; then echo "Already closed: ${MEMBER} is not on the policy."; exit 0; fi
    iap remove-iam-policy-binding --member="$MEMBER" --role="$ROLE" >/dev/null
    echo "Closed. Only the allowlisted identities get past IAP again (existing vaults stay stored; their owners can't reach them until re-added)."
    ;;
  -h | --help) sed -n '2,46p' "$0" ;;
  *) echo "usage: $0 [--open | --close]   (no argument: show the current policy)" >&2; exit 2 ;;
esac
