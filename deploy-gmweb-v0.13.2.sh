#!/usr/bin/env bash
# ADR-007 deploy: GMweb v0.13.2 → VPS 46.31.76.103
# Run: bash deploy-gmweb-v0.13.2.sh   (asks for eve_deploy password once)
set -e
HOST=eve_deploy@46.31.76.103
DIR=/opt/gmweb-api
ORIGIN=https://gmweb.46.31.76.103.nip.io

ssh -t "$HOST" bash -s -- "$DIR" "$ORIGIN" <<'REMOTE'
set -e
DIR=$1; ORIGIN=$2
cd "$DIR"
echo "== current version =="
node -e "console.log(require('./package.json').version)" || true
echo "== pull =="
git stash -q 2>/dev/null || true
git pull --ff-only origin main
echo "== deps =="
npm ci --omit=dev --silent 2>&1 | tail -1 || npm install --omit=dev --silent
echo "== PUBLIC_WEB_ORIGIN (BLOCKER 7: required in production) =="
grep -q '^PUBLIC_WEB_ORIGIN=' .env 2>/dev/null && \
  sed -i "s|^PUBLIC_WEB_ORIGIN=.*|PUBLIC_WEB_ORIGIN=$ORIGIN|" .env || \
  echo "PUBLIC_WEB_ORIGIN=$ORIGIN" >> .env
grep '^PUBLIC_WEB_ORIGIN=' .env
echo "== tests (fast subset) =="
node --test test/pairingSecurity.test.js test/pairingSessions.test.js test/pairingTranscriptVectors.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
echo "== restart =="
pm2 restart gmweb-api --update-env
sleep 3
echo "== health =="
curl -s http://127.0.0.1:3000/health
echo
echo "== pairing surface =="
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
REMOTE
echo "== external health =="
curl -s "$ORIGIN/health"; echo
