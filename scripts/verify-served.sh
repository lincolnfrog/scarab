#!/usr/bin/env bash
# Is scarab.one serving the code in the public repository?
#
#   ./scripts/verify-served.sh                       # scarab.one, the release it says it serves
#   ./scripts/verify-served.sh --tag v0.4.0          # against that release's manifest instead
#   ./scripts/verify-served.sh --origin https://… --repo owner/name   # a self-hosted install
#
# What it does, from outside the page (a bundle that lied about itself could
# patch fetch and crypto inside the page, so the check never runs there):
#   1. fetches the site's index.html and /build.json through IAP as the
#      verifier service account (scarab-verify, which `bootstrap-gcp.sh
#      trust-chain` put on the site's allowlist): a short-lived JWT that gcloud
#      signs as that account — IAP's Google-managed OAuth client takes no
#      programmatic clients, but it accepts a service account's self-signed
#      JWT. You must be allowed to sign as it (the bootstrap grants that to
#      the account that ran it);
#   2. downloads build.json from that release on GitHub and checks its Sigstore
#      attestation with `gh attestation verify`: GitHub's runners built it from
#      the tagged commit by .github/workflows/release.yml;
#   3. downloads every file the attested manifest lists from the site and
#      compares sha256s — index.html included, so a shell that referenced any
#      other script would fail too — and prints the table.
# Exit 0 only when every file matches. Needs curl, jq (or python3), gh, gcloud.
#
# Options: --as EMAIL (the verifier service account; default
# scarab-verify@<PROJECT_ID>… with PROJECT_ID from .env.gcp) · --no-auth (no IAP
# in front; a local server) · --manifest FILE (use this manifest instead of the
# release's) · --unattested (skip step 2; only with --manifest, for testing a
# build you made yourself) · --keep DIR (keep downloads).
#
# Without gcloud: sign in to the site in a browser, open view-source: on it and
# save the page as index.html; open each /assets/… URL it references (and the
# other assets listed in the release's build.json) and save them; then
#   shasum -a 256 index.html assets/*
# and compare with build.json from https://github.com/<repo>/releases, after
#   gh attestation verify build.json --repo <repo>
# The commit the site reports is on Data & Vault → Advanced → Served code.
set -euo pipefail

ORIGIN="https://scarab.one"
REPO="lincolnfrog/scarab"
TAG=""
AUTH=1
VERIFY_SA=""
if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp # PROJECT_ID, for the verifier's default name
fi
MANIFEST=""
ATTEST=1
KEEP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin) ORIGIN="${2%/}"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --as) VERIFY_SA="$2"; shift 2 ;;
    --no-auth) AUTH=0; shift ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --unattested) ATTEST=0; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h | --help) sed -n "2,37p" "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
if [[ $ATTEST -eq 0 && -z "$MANIFEST" ]]; then echo "--unattested only makes sense with --manifest FILE" >&2; exit 2; fi
VERIFY_SA="${VERIFY_SA:-${PROJECT_ID:+scarab-verify@${PROJECT_ID}.iam.gserviceaccount.com}}"

# ---- tools ----
need() { command -v "$1" >/dev/null || { echo "needs $1: $2" >&2; exit 1; }; }
need curl "any system has it"
if command -v jq >/dev/null; then
  json_get() { jq -r "$1 // empty" "$2"; }                                   # <jq path> <file>
  json_assets() { jq -r '.assets | to_entries[] | "\(.key) \(.value)"' "$1"; } # "<path> <sha256>" per line
elif command -v python3 >/dev/null; then
  json_get() { python3 -I -c 'import json,sys; v=json.load(open(sys.argv[2])); k=sys.argv[1].lstrip(".");
v=v.get(k); print("" if v is None else v)' "$1" "$2"; }
  json_assets() { python3 -I -c 'import json,sys
for k,v in json.load(open(sys.argv[1]))["assets"].items(): print(k, v)' "$1"; }
else
  echo "needs jq or python3 to read build.json" >&2; exit 1
fi
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }; else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

# ---- where downloads go ----
if [[ -n "$KEEP" ]]; then mkdir -p "$KEEP"; WORK="$KEEP"; else WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT; fi
mkdir -p "$WORK/served" "$WORK/release"
chmod 700 "$WORK"

# ---- the site, through IAP ----
# The signed JWT goes into a curl config file (mode 600, deleted on exit),
# never onto a command line, and is never printed.
CURL=(curl -sS --fail-with-body --max-time 60)
if [[ $AUTH -eq 1 ]]; then
  need gcloud "https://cloud.google.com/sdk/docs/install, then gcloud auth login as the account bootstrap-gcp.sh trust-chain ran under; or --no-auth for a server without IAP"
  [[ -n "$VERIFY_SA" ]] || { echo "Which verifier? --as scarab-verify@<project>.iam.gserviceaccount.com, or run from the checkout whose .env.gcp names the project." >&2; exit 1; }
  umask 077
  # A self-signed service-account JWT, as IAP's programmatic-access docs describe: iss and sub are the account,
  # aud is this origin with the path wildcard, and it is good for ten minutes (IAP allows up to an hour).
  now=$(date +%s)
  printf '{"iss":"%s","sub":"%s","aud":"%s/*","iat":%s,"exp":%s}\n' "$VERIFY_SA" "$VERIFY_SA" "$ORIGIN" "$now" $((now + 600)) > "$WORK/claim.json"
  if ! gcloud iam service-accounts sign-jwt --iam-account "$VERIFY_SA" "$WORK/claim.json" "$WORK/token.jwt" >/dev/null 2> "$WORK/sign.err"; then
    echo "Couldn't sign a JWT as ${VERIFY_SA}:" >&2
    cat "$WORK/sign.err" >&2
    echo "(gcloud auth login as the account that ran bootstrap-gcp.sh trust-chain, or grant this account roles/iam.serviceAccountTokenCreator on ${VERIFY_SA}.)" >&2
    exit 1
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$WORK/token.jwt")" > "$WORK/.curlrc"
  rm -f "$WORK/token.jwt" "$WORK/claim.json"
  CURL+=(--config "$WORK/.curlrc")
  echo "As:      $VERIFY_SA (through IAP)"
fi
fetch() { # <path> <file> — a status code on failure, no body echoed
  local code
  code=$("${CURL[@]}" -o "$2" -w '%{http_code}' "$ORIGIN$1" 2>/dev/null) || true
  [[ "$code" == 200 ]] && return 0
  if [[ "$code" == 401 || "$code" == 302 || "$code" == 403 ]]; then
    echo "GET $ORIGIN$1 → $code: IAP refused the verifier. ${VERIFY_SA:-It} must be on the site's IAP allowlist" >&2
    echo "(scripts/bootstrap-gcp.sh trust-chain puts it there), and the JWT's audience must be this origin (--origin)." >&2
  else
    echo "GET $ORIGIN$1 → ${code:-no response}" >&2
  fi
  return 1
}

echo "Site:    $ORIGIN"
fetch /index.html "$WORK/served/index.html" || fetch / "$WORK/served/index.html" || exit 1
# An unknown path comes back as the SPA shell with a 200 (server/app.ts), so a server built before the trust
# chain answers /build.json with HTML: that is "no manifest", not a parse error.
if fetch /build.json "$WORK/served/build.json" && [[ "$(head -c1 "$WORK/served/build.json")" == "{" ]]; then
  served_commit=$(json_get .commit "$WORK/served/build.json")
  served_tag=$(json_get .tag "$WORK/served/build.json")
  echo "Serves:  commit ${served_commit:-unknown}${served_tag:+ · release $served_tag}"
else
  echo "Serves:  no /build.json — this server was built before the trust chain, or from source (deploy.sh --source)" >&2
  served_commit=""; served_tag=""
fi

# ---- the release's attested manifest ----
if [[ -n "$MANIFEST" ]]; then
  cp "$MANIFEST" "$WORK/release/build.json"
  echo "Against: $MANIFEST"
else
  TAG="${TAG:-$served_tag}"
  [[ -n "$TAG" ]] || { echo "The site names no release (tag: null) — pass --tag vX.Y.Z to say which release it should be serving." >&2; exit 1; }
  url="https://github.com/${REPO}/releases/download/${TAG}/build.json"
  curl -sSL --fail --max-time 60 -o "$WORK/release/build.json" "$url" || { echo "No build.json on release ${TAG} (${url})" >&2; exit 1; }
  echo "Against: release $TAG of github.com/$REPO"
fi
if [[ $ATTEST -eq 1 ]]; then
  need gh "brew install gh && gh auth login (any GitHub account; the attestation is public)"
  if gh attestation verify "$WORK/release/build.json" --repo "$REPO" --signer-workflow "${REPO}/.github/workflows/release.yml" --format json > "$WORK/attestation.json" 2> "$WORK/attestation.err"; then
    att_ref=$(json_get '.[0].verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.ref' "$WORK/attestation.json" 2>/dev/null || true)
    att_commit=$(json_get '.[0].verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit' "$WORK/attestation.json" 2>/dev/null || true)
    echo "Attested: build.json was built by ${REPO}/.github/workflows/release.yml from ${att_ref:-?} @ ${att_commit:0:7}"
    if [[ -n "$TAG" && -n "$att_ref" && "$att_ref" != "refs/tags/$TAG" ]]; then echo "MISMATCH: the attestation is for $att_ref, not refs/tags/$TAG" >&2; exit 1; fi
  else
    echo "ATTESTATION FAILED for the release's build.json:" >&2
    cat "$WORK/attestation.err" >&2
    exit 1
  fi
fi
expected_commit=$(json_get .commit "$WORK/release/build.json")
if [[ -n "$served_commit" && -n "$expected_commit" && "$served_commit" != "$expected_commit" ]]; then
  echo "NOTE: the site says commit $served_commit; the manifest is for $expected_commit — the files below decide."
fi

# ---- every attested file, as served ----
fail=0
n=0
shell_sha=$(sha "$WORK/served/index.html") # an unknown path comes back as the SPA shell with a 200: that is "missing", not a near miss
printf '\n%-44s  %-14s  %-14s  %s\n' "file" "attested" "served" ""
printf '%-44s  %-14s  %-14s  %s\n' "--------------------------------------------" "--------------" "--------------" "------"
while read -r path want; do
  n=$((n + 1))
  out="$WORK/served/$path"
  mkdir -p "$(dirname "$out")"
  if [[ "$path" == "index.html" ]]; then
    : # already fetched above, before any other request, as a browser would
  elif ! "${CURL[@]}" -o "$out" "$ORIGIN/$path" 2>/dev/null; then
    printf '%-44s  %-14s  %-14s  %s\n' "$path" "${want:0:12}…" "—" "MISSING"
    fail=1
    continue
  fi
  got=$(sha "$out")
  if [[ "$got" == "$want" ]]; then
    printf '%-44s  %-14s  %-14s  %s\n' "$path" "${want:0:12}…" "${got:0:12}…" "ok"
  elif [[ "$path" != "index.html" && "$got" == "$shell_sha" ]]; then
    printf '%-44s  %-14s  %-14s  %s\n' "$path" "${want:0:12}…" "(the shell)" "MISSING"
    fail=1
  else
    printf '%-44s  %-14s  %-14s  %s\n' "$path" "${want:0:12}…" "${got:0:12}…" "MISMATCH"
    fail=1
  fi
done < <(json_assets "$WORK/release/build.json")

# Anything the served shell references that the manifest doesn't list (redundant
# with the index.html hash above, but it names the intruder when that fails).
extra=0
while read -r ref; do
  path="${ref#/}"
  if ! json_assets "$WORK/release/build.json" | cut -d' ' -f1 | grep -qx "$path"; then
    printf '%-44s  %-14s  %-14s  %s\n' "$path" "—" "(referenced)" "NOT IN MANIFEST"
    extra=1
  fi
done < <(grep -oE '(src|href)="/[^"]+"' "$WORK/served/index.html" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)

echo
if [[ $fail -eq 0 && $extra -eq 0 ]]; then
  echo "OK: all $n attested files are what $ORIGIN serves."
  exit 0
fi
echo "FAILED: $ORIGIN does not serve the attested release. Keep the downloads with --keep DIR and compare." >&2
exit 1
