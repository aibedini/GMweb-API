#!/usr/bin/env bash
# Coordinated GMweb pairing release. Physical E2E evidence is mandatory.
set -euo pipefail
HOST=root@46.31.76.103
DIR=/opt/gmweb-api
ORIGIN=https://gmweb.46.31.76.103.nip.io

ssh -t "$HOST" bash -s -- "$DIR" "$ORIGIN" <<'REMOTE'
set -euo pipefail
DIR=$1
ORIGIN=$2
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
node "$STAGE/scripts/check-pairing-release.js"   /opt/gmweb-release-evidence/pairing-e2e.json   /opt/gmweb-release-evidence/messages.apk
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
