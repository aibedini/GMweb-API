#!/usr/bin/env bash
# Coordinated GMweb pairing deployment. Physical E2E evidence is mandatory.
set -euo pipefail

: "${GMWEB_DEPLOY_HOST:?Set GMWEB_DEPLOY_HOST (for example, deploy@example.net)}"
: "${GMWEB_PUBLIC_ORIGIN:?Set GMWEB_PUBLIC_ORIGIN (for example, https://gmweb.example.net)}"

HOST=$GMWEB_DEPLOY_HOST
DIR=${GMWEB_DEPLOY_DIR:-/opt/gmweb-api}
ORIGIN=$GMWEB_PUBLIC_ORIGIN
EVIDENCE_DIR=${GMWEB_RELEASE_EVIDENCE_DIR:-/opt/gmweb-release-evidence}

ssh -t "$HOST" bash -s -- "$DIR" "$ORIGIN" "$EVIDENCE_DIR" <<'REMOTE'
set -euo pipefail
DIR=$1
ORIGIN=$2
EVIDENCE_DIR=$3
cd "$DIR"
grep -q '^PUBLIC_WEB_ORIGIN=https://' .env
grep -q '^PUBLIC_API_ORIGIN=https://' .env
# Keep operator edits visible; never stash them implicitly during deployment.
git diff --quiet
git diff --cached --quiet
git fetch origin main
CANDIDATE=$(git rev-parse FETCH_HEAD)
STAGE=$(mktemp -d /tmp/gmweb-pairing.XXXXXXXX)
cleanup() {
  case "$STAGE" in /tmp/gmweb-pairing.*) rm -rf -- "$STAGE" ;; esac
}
trap cleanup EXIT
git archive "$CANDIDATE" | tar -x -C "$STAGE"
# Validate the incoming files BEFORE any live API/PWA files are replaced.
node "$STAGE/scripts/check-pairing-release.js" \
  "$EVIDENCE_DIR/pairing-e2e.json" \
  "$EVIDENCE_DIR/messages.apk"
(
  cd "$STAGE"
  npm ci --include=dev
  npm run check
  npm test
)
# Promote exactly the revision that passed; do not fetch another revision.
git merge --ff-only "$CANDIDATE"
npm ci --omit=dev
systemctl restart gmweb-api.service
curl --fail --retry 5 --retry-connrefused --retry-delay 2 http://127.0.0.1:3030/health
REMOTE
curl --fail "$ORIGIN/health"
