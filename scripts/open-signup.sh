#!/usr/bin/env bash
# Open scarab.one to every Google account — or close it again.
#
#   ./scripts/open-signup.sh            # show IAP's current policy, the deployed mode, and what each flag would do
#   ./scripts/open-signup.sh --open     # any Google account may sign in and create its own vault (vault-only deploys)
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
# Vault-only is the precondition, and --open checks it on the LIVE service, not
# in .env.gcp: it reads the deployed revision's environment and refuses unless
# SCARAB_ZK_ONLY is set there. A household-mode server holds the household's
# ledger in plaintext and has no member gate of its own (server/app.ts only
# reads the email IAP hands it; the IAP allowlist IS the gate), so opening IAP
# on one would hand every Google account the household's data.
# --i-know-this-is-plaintext overrides the check, for someone who has read
# this paragraph and means exactly that.
#
# What the server and IAP then learn, and the rest of the honest accounting,
# is PRIVACY.md → "Open sign-up". The terms and privacy pages the front door
# links to (public/terms.html, public/privacy.html) name the contact address
# (help.scarab.one@gmail.com): keep it current.
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
#
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

# The value of SCARAB_ZK_ONLY in the LIVE service's template (the revision that serves traffic is deployed from it),
# or "" when it is not set there. Read from the service itself, never from .env.gcp — that file says what the next
# deploy would set, not what runs now.
live_zk_only() {
  local svc
  svc=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format=json)
  if command -v jq >/dev/null; then
    jq -r '[.spec.template.spec.containers[0].env[]? | select(.name == "SCARAB_ZK_ONLY") | .value][0] // ""' <<<"$svc"
  elif command -v python3 >/dev/null; then
    python3 -I -c 'import json,sys
env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env") or []
print(next((e.get("value", "") for e in env if e.get("name") == "SCARAB_ZK_ONLY"), ""))' <<<"$svc"
  else
    # No JSON tool: gcloud's own rendering of the env list, one {'name': …, 'value': …} per entry.
    gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
      --format 'value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep "'SCARAB_ZK_ONLY'" | sed -E "s/.*'value': '([^']*)'.*/\1/" || true
  fi
}
# server/index.ts reads the flag as 1, true or yes (case-insensitive).
is_on() { [[ "$(tr '[:upper:]' '[:lower:]' <<<"$1")" =~ ^(1|true|yes)$ ]]; }

# Describe the deployed mode in a sentence; prints "zk" or "plaintext" for the caller.
mode() { # [--show]
  local v
  v=$(live_zk_only)
  if is_on "$v"; then
    [[ "${1:-}" == "--show" ]] && echo "The deployed service is vault-only (SCARAB_ZK_ONLY=${v}): it stores ciphertext and gives a new identity an empty front door." >&2
    echo zk
  else
    [[ "${1:-}" == "--show" ]] && echo "The deployed service is in HOUSEHOLD MODE (SCARAB_ZK_ONLY is ${v:+\"$v\" — }${v:-not set}): it holds the household's ledger in plaintext, and the IAP allowlist is its only gate." >&2
    echo plaintext
  fi
}

action="${1:-}"
override=0
for arg in "${@:2}"; do
  case "$arg" in
    --i-know-this-is-plaintext) override=1 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

case "$action" in
  "")
    now=$(state --show)
    echo >&2
    deployed=$(mode --show)
    echo
    if [[ "$now" == open ]]; then
      echo "Sign-up is OPEN: ${MEMBER} holds ${ROLE}, so any Google account can sign in."
      [[ "$deployed" == plaintext ]] && echo "!!  …to a server holding plaintext. Every Google account can read the household's data. Run --close now."
      echo "  --close removes that binding; the people and service accounts listed above keep their access."
    else
      echo "Sign-up is CLOSED: only the identities listed above get past IAP."
      echo "  --open adds ${MEMBER} with ${ROLE}: every Google account may then sign in and create its own vault."
      if [[ "$deployed" == plaintext ]]; then
        echo "  --open will refuse while the deployed service holds plaintext: deploy vault-only first (SCARAB_ZK_ONLY=1 in .env.gcp, then"
        echo "  SCARAB_PURGE_PLAINTEXT=1 ./scripts/deploy.sh once — export the household's data before that; README)."
      else
        echo "  Before that: release and deploy the terms and privacy pages, and"
        echo "  check the OAuth consent screen's publishing status (see the header of this script)."
      fi
    fi
    ;;
  --open)
    if [[ "$(state)" == open ]]; then echo "Already open: ${MEMBER} holds ${ROLE}."; exit 0; fi
    if [[ "$(mode --show)" == plaintext ]]; then
      if [[ $override -eq 0 ]]; then
        echo >&2
        echo "Refusing to open: the deployed service is not vault-only. Opening IAP on it would let every Google account" >&2
        echo "in the world read and change the household's plaintext ledger — the app has no gate of its own behind IAP." >&2
        echo "Deploy vault-only first (SCARAB_ZK_ONLY=1; README → Vault-only deploy), then run this again." >&2
        echo "If you mean to expose a plaintext server to everyone anyway: --open --i-know-this-is-plaintext." >&2
        exit 1
      fi
      echo "!!  --i-know-this-is-plaintext: opening a server that holds plaintext to every Google account."
    fi
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
  -h | --help) sed -n '2,54p' "$0" ;;
  *) echo "usage: $0 [--open [--i-know-this-is-plaintext] | --close]   (no argument: show the current policy and the deployed mode)" >&2; exit 2 ;;
esac
