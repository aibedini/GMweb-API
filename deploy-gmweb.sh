#!/usr/bin/env bash
# Coordinated GMweb deployment with release-integrity gates.
#
# A successful run means EVERY component agrees on ONE revision:
#
#   source revision
#     -> locked dependencies
#     -> built front-ends (dashboard-next -> public/dashboard-next, web -> public/web-app)
#     -> artifacts verified to belong to that revision
#     -> exact candidate promoted
#     -> API restarted
#     -> post-deploy validation of API + served PWA + dashboard
#
# Nothing live is touched until the candidate has been built and verified in a
# staging directory, so production can never briefly serve a half-built PWA or
# a bundle left over from an earlier release. The candidate SHA is pinned before
# validation and is never re-fetched afterwards.
set -euo pipefail

: "${GMWEB_DEPLOY_HOST:?Set GMWEB_DEPLOY_HOST (for example, deploy@example.net)}"
: "${GMWEB_PUBLIC_ORIGIN:?Set GMWEB_PUBLIC_ORIGIN (for example, https://gmweb.example.net)}"

HOST=$GMWEB_DEPLOY_HOST
DIR=${GMWEB_DEPLOY_DIR:-/opt/gmweb-api}
ORIGIN=$GMWEB_PUBLIC_ORIGIN
EVIDENCE_DIR=${GMWEB_RELEASE_EVIDENCE_DIR:-/opt/gmweb-release-evidence}
API_PORT=${GMWEB_API_PORT:-3030}

ssh -t "$HOST" bash -s -- "$DIR" "$ORIGIN" "$EVIDENCE_DIR" "$API_PORT" <<'REMOTE'
set -euo pipefail
DIR=$1
ORIGIN=$2
EVIDENCE_DIR=$3
API_PORT=$4
BASE="http://127.0.0.1:$API_PORT"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# The revision that was live before this run, so a post-activation failure can be undone.
# Set after the preflight (which must not mutate anything) and before any promotion.
PREVIOUS_REVISION=""
rollback() {
  local reason="$1"
  printf '\n!! %s\n' "$reason" >&2
  if [ -z "$PREVIOUS_REVISION" ]; then
    printf '   nothing had been promoted yet, so there is nothing to roll back.\n' >&2
    exit 1
  fi
  printf '   rolling back to %s\n' "$(git rev-parse --short "$PREVIOUS_REVISION")" >&2
  if git reset --hard "$PREVIOUS_REVISION" >&2; then
    npm ci --omit=dev >&2 || printf '   warning: dependency restore failed; the previous revision is checked out\n' >&2
    systemctl restart gmweb-api.service >&2 || true
    printf '   rolled back; verify with: systemctl status gmweb-api.service\n' >&2
  else
    printf '   ROLLBACK FAILED. The checkout is at %s and needs manual attention.\n' "$(git rev-parse --short HEAD)" >&2
  fi
  exit 1
}

cd "$DIR"

log "Preflight: ADR-007 public origins must be valid BEFORE anything is activated"
# The previous check here was a single grep for the key in the environment file. It accepted
# values the application rejects (a trailing slash, a path, localhost, a private address), and
# it proved nothing about the value SYSTEMD hands the process — which is the value ADR-007
# actually reads. The preflight resolves, validates, persists and verifies propagation, and
# refuses to continue otherwise, so a predictable failure stops the deploy instead of
# restarting into a crash loop.
PREFLIGHT="$DIR/scripts/publicOriginPreflight.js"
[ -f "$PREFLIGHT" ] || fail "missing $PREFLIGHT; cannot validate ADR-007 origins"
node "$PREFLIGHT" --app-dir "$DIR" --web-origin "$ORIGIN" --non-interactive \
  || fail "ADR-007 preflight failed: PUBLIC_WEB_ORIGIN is missing or invalid. Nothing was activated."
# The preflight may install an EnvironmentFile drop-in, and `systemctl restart` alone does NOT
# re-read unit definitions.
if systemctl daemon-reload 2>/dev/null; then :; else fail "systemctl daemon-reload failed"; fi

log "Preflight: the checkout must be clean"
# Keep operator edits visible; never stash them implicitly during deployment.
git diff --quiet || fail "working tree has uncommitted changes; refusing to deploy"
git diff --cached --quiet || fail "index has staged changes; refusing to deploy"

log "Pinning the exact candidate revision"
git fetch origin main
CANDIDATE=$(git rev-parse FETCH_HEAD)
CANDIDATE_SHORT=$(git rev-parse --short "$CANDIDATE")
EXPECTED_VERSION=$(git show "$CANDIDATE:package.json" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
echo "candidate=$CANDIDATE_SHORT  expected_version=$EXPECTED_VERSION"

STAGE=$(mktemp -d /tmp/gmweb-release.XXXXXXXX)
cleanup() {
  case "$STAGE" in /tmp/gmweb-release.*) rm -rf -- "$STAGE" ;; esac
}
trap cleanup EXIT

log "Staging the candidate (no live file is touched yet)"
git archive "$CANDIDATE" | tar -x -C "$STAGE"

log "Release evidence gate"
node "$STAGE/scripts/check-pairing-release.js" \
  "$EVIDENCE_DIR/pairing-e2e.json" \
  "$EVIDENCE_DIR/messages.apk"

log "Locked dependencies + release gates (in the stage)"
(
  cd "$STAGE"
  # Provenance: the artifact records the revision it was built from, so two
  # builds with the same semantic version can still be told apart.
  export GMWEB_BUILD_REVISION="$CANDIDATE"
  npm ci --include=dev
  npm run check
  npm test
  # npm ci + build + verify for BOTH front-ends.
  npm run build:frontends
)

log "Staged artifacts must belong to the candidate version"
STAGED_VERSION=$(node -pe "require('$STAGE/public/web-app/version.json').version")
[ "$STAGED_VERSION" = "$EXPECTED_VERSION" ] \
  || fail "staged PWA is $STAGED_VERSION but package.json is $EXPECTED_VERSION"

log "Promoting exactly the revision that passed"
git merge --ff-only "$CANDIDATE"
npm ci --omit=dev

log "Serving exactly the artifacts that were built and verified"
for app in web-app dashboard-next; do
  src="$STAGE/public/$app/"
  [ -d "$src" ] || fail "staged artifacts missing: $src"
  mkdir -p "$DIR/public/$app"
  # --delete removes hashed bundles from the previous release, which is what
  # stops a stale index.html from pointing at files that no longer exist.
  rsync -a --delete "$src" "$DIR/public/$app/"
done
chown -R "$(stat -c '%U:%G' "$DIR")" "$DIR/public"

log "Verifying the LIVE artifacts before restarting anything"
node "$DIR/scripts/verify-frontend-artifacts.mjs"

log "Restarting the API"
# Record the state BEFORE the restart so a restart loop is distinguishable from a healthy
# unit: NRestarts is cumulative, and ActiveState alone says nothing about flapping.
PREVIOUS_REVISION=$(git rev-parse HEAD)
RESTARTS_BEFORE=$(systemctl show -p NRestarts --value gmweb-api.service 2>/dev/null || echo 0)
systemctl restart gmweb-api.service
curl --fail --retry 5 --retry-connrefused --retry-delay 2 -s -o /dev/null "$BASE/health"

log "Post-deploy validation"

# --- service health: a restart loop is a FAILURE, never a success -------------------
sleep 3
ACTIVE=$(systemctl show -p ActiveState --value gmweb-api.service 2>/dev/null || echo unknown)
SUBSTATE=$(systemctl show -p SubState --value gmweb-api.service 2>/dev/null || echo unknown)
RESTARTS_AFTER=$(systemctl show -p NRestarts --value gmweb-api.service 2>/dev/null || echo 0)
echo "gmweb-api.service: active=$ACTIVE sub=$SUBSTATE NRestarts=$RESTARTS_BEFORE->$RESTARTS_AFTER"

if [ "$ACTIVE" != "active" ]; then
  echo "--- recent journal ---" >&2
  journalctl -u gmweb-api.service -n 30 --no-pager >&2 || true
  rollback "gmweb-api.service is not active after the restart (state: $ACTIVE)"
fi
if [ "${RESTARTS_AFTER:-0}" -gt "${RESTARTS_BEFORE:-0}" ]; then
  echo "--- recent journal ---" >&2
  journalctl -u gmweb-api.service -n 30 --no-pager >&2 || true
  rollback "gmweb-api.service restarted $((RESTARTS_AFTER - RESTARTS_BEFORE)) time(s) after deployment; refusing to claim success"
fi

# The RUNNING process must actually hold the origin, which is a stronger statement than
# "the file contains it" and is what ADR-007 checks at boot. Compared without printing it.
MAIN_PID=$(systemctl show -p MainPID --value gmweb-api.service 2>/dev/null || echo 0)
if [ "${MAIN_PID:-0}" -gt 1 ] && [ -r "/proc/$MAIN_PID/environ" ]; then
  PROCESS_ORIGIN=$(tr '\0' '\n' <"/proc/$MAIN_PID/environ" | sed -n 's/^PUBLIC_WEB_ORIGIN=//p' | head -1)
  if [ "$PROCESS_ORIGIN" = "$ORIGIN" ]; then
    echo "running process (pid $MAIN_PID) has the expected PUBLIC_WEB_ORIGIN"
  else
    rollback "the running process does not carry the expected PUBLIC_WEB_ORIGIN; the ADR-007 prerequisite is not satisfied"
  fi
fi

# Pairing routes are the surface ADR-007 guards, so exercise the gate itself rather than
# assuming a healthy /health implies a healthy origin contract. An unauthenticated request
# must be rejected with 401 (not 500), which proves the module loaded and did not throw.
PAIRING_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/pairing/session" \
  -H 'Content-Type: application/json' -d '{}' || echo 000)
case "$PAIRING_CODE" in
  401|403) echo "pairing route reachable and enforcing auth (HTTP $PAIRING_CODE)" ;;
  000) rollback "pairing route did not answer at all" ;;
  5*)  rollback "pairing route returned HTTP $PAIRING_CODE — the ADR-007 origin gate is probably still failing" ;;
  *)   echo "note: pairing route answered HTTP $PAIRING_CODE (expected an auth rejection)" ;;
esac

LOCAL_VERSION=$(curl -fsS "$BASE/health" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[ "$LOCAL_VERSION" = "$EXPECTED_VERSION" ] \
  || rollback "API reports $LOCAL_VERSION, expected $EXPECTED_VERSION"

SERVED_PWA=$(curl -fsS "$BASE/web/version.json" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[ "$SERVED_PWA" = "$EXPECTED_VERSION" ] \
  || rollback "/web/version.json reports $SERVED_PWA, expected $EXPECTED_VERSION"

# Every asset the served entry point references must actually be served: this is
# the check that would have caught the stale-artifact release.
INDEX=$(curl -fsS "$BASE/web/")
for ref in $(printf '%s' "$INDEX" | grep -oE '/web/assets/[^"'"'"']+'); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ref")
  [ "$code" = "200" ] || rollback "served /web references $ref which returns HTTP $code"
done
DASH_INDEX=$(curl -fsS "$BASE/app/")
for ref in $(printf '%s' "$DASH_INDEX" | grep -oE '/app/assets/[^"'"'"']+'); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ref")
  [ "$code" = "200" ] || rollback "served /app references $ref which returns HTTP $code"
done

# Admin view must agree too. The token is read from .env and never printed.
TOKEN=$(sed -n 's/^API_TOKEN=//p' "$DIR/.env" | head -1 | tr -d '"')
if [ -n "$TOKEN" ]; then
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/admin/overview" | node -e '
    let d = "";
    process.stdin.on("data", (c) => { d += c; }).on("end", () => {
      const o = JSON.parse(d);
      if (!o.webApp || o.webApp.matchesApi !== true) {
        console.error("admin overview reports a PWA mismatch: " + JSON.stringify(o.webApp));
        process.exit(1);
      }
      const t = o.transport || {};
      const q = o.queue || {};
      console.log(
        "admin overview: version=" + o.version +
        " pwa=" + o.webApp.version + " matchesApi=true" +
        " transport=" + t.activeTransport + "/" + t.mode + " state=" + t.state + " ready=" + t.ready +
        " queue waiting=" + (q.waiting ?? "?") + " active=" + (q.active ?? "?")
      );
    });'
else
  echo "note: no API_TOKEN in .env; skipping the admin overview check"
fi

echo
echo "deployed $CANDIDATE_SHORT ($EXPECTED_VERSION): API, PWA and console all agree"
REMOTE

curl --fail "$ORIGIN/health"
