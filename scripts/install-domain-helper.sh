#!/usr/bin/env bash
# Installs the privileged domain helper and its narrow sudoers rule.
#
#   sudo bash scripts/install-domain-helper.sh [--with-packages] [--app-user gmweb]
#
# What it grants: the app user may run EXACTLY these three subcommands as root:
#   gmweb-domain-helper apply|issue|remove <args>
# The helper validates every argument itself and accepts no paths or nginx text.
# --with-packages additionally installs nginx and certbot (apt).
set -euo pipefail

APP_USER="gmweb"
WITH_PACKAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-packages) WITH_PACKAGES=1 ;;
    --app-user) APP_USER="${2:?--app-user needs a value}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
[[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "Invalid app user name." >&2; exit 2; }
id "$APP_USER" >/dev/null 2>&1 || { echo "User '$APP_USER' does not exist." >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER=/usr/local/sbin/gmweb-domain-helper
SUDOERS=/etc/sudoers.d/gmweb-domain-helper

if [[ "$WITH_PACKAGES" -eq 1 ]]; then
  echo "==> Installing nginx and certbot"
  apt-get update
  apt-get install -y nginx certbot python3-certbot-nginx
  systemctl enable --now nginx
fi

echo "==> Installing $HELPER (root-owned, not writable by $APP_USER)"
install -o root -g root -m 0755 "$SRC_DIR/gmweb-domain-helper.sh" "$HELPER"

echo "==> Installing sudoers rule"
tmp="$(mktemp)"
cat > "$tmp" <<SUDOERS_RULE
# Managed by gmweb install-domain-helper.sh. Exact subcommands only.
$APP_USER ALL=(root) NOPASSWD: $HELPER apply *, $HELPER issue *, $HELPER remove *
SUDOERS_RULE
visudo -cf "$tmp" >/dev/null
install -o root -g root -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
visudo -cf "$SUDOERS" >/dev/null

echo "==> Checking"
command -v nginx   >/dev/null 2>&1 && echo "  nginx:   present" || echo "  nginx:   MISSING (re-run with --with-packages)"
command -v certbot >/dev/null 2>&1 && echo "  certbot: present" || echo "  certbot: MISSING (re-run with --with-packages)"
sudo -n -u "$APP_USER" sudo -n -l "$HELPER" apply probe.invalid main-web >/dev/null 2>&1 \
  && echo "  sudo rule for $APP_USER: OK" || echo "  sudo rule for $APP_USER: NOT effective"
echo "Done. Open ports 80 and 443 in the firewall for certificate issuance."
