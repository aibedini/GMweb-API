#!/usr/bin/env bash
# GMweb backup -- exactly ONE rolling snapshot, never a pile.
#
# This server holds the only copy of the encrypted event store
# (control-plane.db) and the send ledger (sends.db), so a restore point
# matters. Unbounded snapshots are how a 46 GB disk fills up unnoticed: the
# field box had 482 MB of loose backups plus a 2.8 GB stale rollback release
# nobody remembered. Every run REPLACES the previous archive, so there is
# always exactly one, and it is always the newest known-good state.
#
# Usage: sudo gmweb backup     (or: sudo bash scripts/gmweb-backup.sh)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gmweb-api}"
BACKUP_DIR="${BACKUP_DIR:-/root/gmweb-backup}"
KEEP="${KEEP:-1}"

log() { echo "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  log "Run as root: sudo gmweb backup"
  exit 1
fi
if [[ ! -d "$APP_DIR/data" ]]; then
  log "No data directory at $APP_DIR/data -- is GMweb installed?"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$BACKUP_DIR/gmweb-$stamp.tar.gz"
staging="$(mktemp -d "$BACKUP_DIR/.staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

# SQLite hot backup. A plain cp of a WAL database taken mid-write is not a
# trustworthy restore point; better-sqlite3's backup API is safe while the API
# and Chrome keep running.
copy_db() {
  local name="$1" src="$APP_DIR/data/$1"
  if [[ ! -f "$src" ]]; then
    return 0
  fi
  if [[ -d "$APP_DIR/node_modules/better-sqlite3" ]]; then
    if ! node -e "
      const D=require('$APP_DIR/node_modules/better-sqlite3');
      const db=new D('$src',{readonly:true});
      db.backup('$staging/$name').then(()=>{db.close();process.exit(0)})
        .catch(e=>{console.error(e.message);process.exit(1)});
    "; then
      log "hot backup FAILED for $name"
      return 1
    fi
  else
    cp -a "$src" "$staging/$name"
  fi
  log "  + $name"
}

log "Backing up $APP_DIR"
log "  -> $archive"
copy_db control-plane.db
copy_db sends.db
if [[ -f "$APP_DIR/.env" ]]; then
  cp -a "$APP_DIR/.env" "$staging/env"
  log "  + env"
fi

{
  echo "created=$(date -Is)"
  echo "host=$(hostname)"
  echo "git_head=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "version=$(node -e "console.log(require('$APP_DIR/package.json').version)" 2>/dev/null || echo unknown)"
} > "$staging/MANIFEST"

tar czf "$archive" -C "$staging" .
chmod 600 "$archive"
log "Snapshot written: $archive ($(du -h "$archive" | cut -f1))"

# Retention: keep the newest KEEP archives (default exactly one) and remove our
# older snapshots. Other files in BACKUP_DIR are left alone -- this script only
# ever cleans up after itself.
if (( KEEP > 0 )); then
  mapfile -t snapshots < <(find "$BACKUP_DIR" -maxdepth 1 -name 'gmweb-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  if (( ${#snapshots[@]} > KEEP )); then
    for old in "${snapshots[@]:KEEP}"; do
      rm -f -- "$old"
      log "Pruned older backup: $old"
    done
  fi
  log "Backups kept: $(find "$BACKUP_DIR" -maxdepth 1 -name 'gmweb-*.tar.gz' | wc -l)"
fi
