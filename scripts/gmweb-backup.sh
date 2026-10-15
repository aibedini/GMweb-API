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

# Shared zstd bootstrap + size formatting. Absent lib is not fatal: we simply
# fall back to gzip below.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/gmweb-lib.sh" ]]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/gmweb-lib.sh"
fi
if ! declare -F ensure_zstd >/dev/null 2>&1; then
  ensure_zstd() { command -v zstd >/dev/null 2>&1; }
fi
if ! declare -F gmweb_fmt_bytes >/dev/null 2>&1; then
  gmweb_fmt_bytes() { du -h "$1" 2>/dev/null | cut -f1; }
fi

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
staging="$(mktemp -d "$BACKUP_DIR/.staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

# Prefer zstd (multi-threaded), fall back to gzip. Never fail the backup just
# because zstd is unavailable.
if ensure_zstd; then
  archive="$BACKUP_DIR/gmweb-$stamp.tar.zst"
  ZSTD=1
else
  archive="$BACKUP_DIR/gmweb-$stamp.tar.gz"
  ZSTD=0
  log "zstd unavailable; using gzip fallback"
fi

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

if (( ZSTD == 1 )); then
  # -T0 = all cores, -1 = fastest level: a ~1 GB snapshot compresses in seconds.
  tar -C "$staging" -cf - . | zstd -T0 -1 -q -o "$archive"
else
  tar czf "$archive" -C "$staging" .
fi
chmod 600 "$archive"
log "Snapshot written: $archive ($(gmweb_fmt_bytes "$(stat -c%s "$archive" 2>/dev/null || echo 0)"))"

# Retention: keep the newest KEEP snapshots created by THIS script and remove
# only those. Both formats are recognised so a gzip fallback snapshot still
# participates. Unrelated files (api-keys.pre-*, sends.db.pre-correction, ...)
# are never touched.
if (( KEEP > 0 )); then
  mapfile -t snapshots < <(find "$BACKUP_DIR" -maxdepth 1 \
    \( -name 'gmweb-*.tar.gz' -o -name 'gmweb-*.tar.zst' \) \
    -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
  if (( ${#snapshots[@]} > KEEP )); then
    for old in "${snapshots[@]:KEEP}"; do
      rm -f -- "$old"
      log "Pruned older backup: $old"
    done
  fi
  log "Backups kept: $(find "$BACKUP_DIR" -maxdepth 1 \
    \( -name 'gmweb-*.tar.gz' -o -name 'gmweb-*.tar.zst' \) | wc -l)"
fi
