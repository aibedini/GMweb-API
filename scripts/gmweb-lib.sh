#!/usr/bin/env bash
# Shared helpers for the GMweb management scripts.
#
# Sourced by scripts/gmweb-menu.sh and scripts/gmweb-backup.sh so that zstd
# bootstrapping, timing and size reporting exist in exactly ONE place.

# ── timing ───────────────────────────────────────────────────────────────────
# Millisecond clock without depending on GNU `date +%s%N` quirks elsewhere.
gmweb_now_ms() { date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

# Formats a millisecond duration as a short human string.
gmweb_fmt_ms() {
  local ms="${1:-0}"
  if (( ms < 1000 )); then printf '%sms' "$ms"
  else awk -v m="$ms" 'BEGIN{printf "%.1fs", m/1000}'; fi
}

# ── disk telemetry ───────────────────────────────────────────────────────────
# Used bytes on the filesystem holding $1.
gmweb_disk_used_bytes() { df -B1 --output=used "${1:-/}" 2>/dev/null | tail -1 | tr -d ' '; }

gmweb_fmt_bytes() {
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN{
    split("B KB MB GB TB", u, " "); i=1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf (i==1 ? "%d %s" : "%.2f %s"), b, u[i]
  }'
}

# ── zstd bootstrap ───────────────────────────────────────────────────────────
# Ensures zstd is available, installing it AT MOST ONCE when genuinely missing.
#
# Called ONLY when a backup is actually required and zstd is absent, so a normal
# schema-neutral update never touches apt.
#
# A failure here must NEVER fail the GMweb update: the backup script falls back
# to gzip. apt/dpkg locks are bounded so an update can never hang on them.
ensure_zstd() {
  if command -v zstd >/dev/null 2>&1; then
    return 0
  fi

  echo "zstd not found — installing once..."

  if command -v apt-get >/dev/null 2>&1; then
    # DPkg::Lock::Timeout bounds the wait instead of blocking forever.
    if DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=30 update >/dev/null 2>&1 &&
       DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=30 \
         install -y --no-install-recommends zstd >/dev/null 2>&1 &&
       command -v zstd >/dev/null 2>&1; then
      echo "✓ zstd installed: $(zstd --version 2>/dev/null | head -1)"
      return 0
    fi
  fi

  echo "! Could not install zstd; backup will use gzip fallback."
  return 1
}
