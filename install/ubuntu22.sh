#!/usr/bin/env bash
set -euo pipefail

APP_NAME="GMweb API"
APP_SLUG="gmweb-api"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
APP_PORT="${APP_PORT:-3030}"
PUBLIC_HOST="${PUBLIC_HOST:-0.0.0.0}"
PUBLIC_DASHBOARD="${PUBLIC_DASHBOARD:-auto}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
CDP_PORT="${CDP_PORT:-9222}"
SERVER_TIMEZONE="${SERVER_TIMEZONE:-Asia/Tehran}"
REPO_URL="${REPO_URL:-https://github.com/aibedini/GMweb-API.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash install/ubuntu22.sh"
  exit 1
fi

echo "==> Setting server timezone: $SERVER_TIMEZONE"
timedatectl set-timezone "$SERVER_TIMEZONE"

as_app_user() {
  runuser -u "$APP_USER" -- bash -lc "$*"
}

if [[ "$(lsb_release -rs 2>/dev/null || true)" != "22.04" ]]; then
  echo "Warning: this installer is designed for Ubuntu 22.04."
fi

echo "==> Installing system packages"
apt-get update
apt-get install -y ca-certificates curl wget gnupg git rsync sudo tar xvfb x11vnc fluxbox novnc websockify redis-server jq
systemctl enable --now redis-server

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "==> Installing Google Chrome"
  install -d -m 0755 /etc/apt/keyrings
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update
  apt-get install -y google-chrome-stable
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "==> Creating service user: $APP_USER"
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

echo "==> Preparing app directory: $APP_DIR"
mkdir -p "$APP_DIR"

if [[ -f "$SOURCE_DIR/package.json" ]]; then
  if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
    echo "No REPO_URL provided. Syncing project from $SOURCE_DIR to $APP_DIR."
    rsync -a --delete \
      --exclude ".git/" \
      --exclude ".env" \
      --exclude "data/" \
      --exclude "node_modules/" \
      "$SOURCE_DIR/" "$APP_DIR/"
  else
    echo "No REPO_URL provided. Using project files already in $APP_DIR."
  fi
elif [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
elif [[ -n "$REPO_URL" ]]; then
  TEMP_CHECKOUT="$(mktemp -d)"
  trap 'rm -rf "$TEMP_CHECKOUT"' EXIT
  git clone --depth 1 "$REPO_URL" "$TEMP_CHECKOUT"
  rsync -a --delete \
    --exclude ".git/" \
    --exclude ".env" \
    --exclude "data/" \
    --exclude "node_modules/" \
    "$TEMP_CHECKOUT/" "$APP_DIR/"
else
  echo "No REPO_URL provided and no package.json found next to this installer."
  echo "Run from a cloned GMweb API repo or pass REPO_URL=https://github.com/.../GMweb-API.git"
  exit 1
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [[ ! -f "$APP_DIR/package-lock.json" ]]; then
  echo "package-lock.json not found in $APP_DIR."
  echo "The app directory is not a complete GMweb API checkout."
  exit 1
fi

echo "==> Installing npm dependencies"
as_app_user "cd '$APP_DIR' && npm ci --omit=dev"

echo "==> Building React console (/app)"
as_app_user "cd '$APP_DIR/dashboard-next' && npm ci && npm run build"

TOKEN="$(as_app_user "cd '$APP_DIR' && node scripts/new-token.js")"
DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-gmwebadmin}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-$(node -e "console.log(require('node:crypto').randomBytes(33).toString('base64url'))")}"
DASHBOARD_PASSWORD_HASH="$(printf '%s' "$DASHBOARD_PASSWORD" | runuser -u "$APP_USER" -- node "$APP_DIR/scripts/hash-password.js" --stdin)"
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> Creating .env"
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=$APP_PORT
HOST=$PUBLIC_HOST
API_TOKEN=$TOKEN
HEADLESS=false
USER_DATA_DIR=./data/browser-profile
CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome
BROWSER_MODE=connect
BROWSER_CDP_URL=http://127.0.0.1:$CDP_PORT
POLL_INTERVAL_MS=0
CONVERSATION_CACHE_FILE=./data/conversation-cache.json
WEBHOOK_URL=
ENABLE_DEBUG_ROUTES=false
PUBLIC_HEALTH=true
CORS_ORIGIN=
DASHBOARD_ENABLED=true
ADMIN_ACTIONS_ENABLED=true
DASHBOARD_USERNAME=$DASHBOARD_USERNAME
DASHBOARD_PASSWORD_HASH=$DASHBOARD_PASSWORD_HASH
DASHBOARD_PASSWORD_SESSION_TTL_MS=600000
DASHBOARD_PASSWORD_WINDOW_MS=900000
DASHBOARD_PASSWORD_MAX=5
DASHBOARD_COOKIE_SECURE=false
DASHBOARD_LOGIN_WINDOW_MS=60000
DASHBOARD_LOGIN_MAX=20
ADMIN_ACTION_WINDOW_MS=60000
ADMIN_ACTION_MAX=60
VNC_PROXY_TARGET=http://127.0.0.1:6080
SEND_TIMEZONE=Asia/Tehran
SEND_QUIET_START_HOUR=2
SEND_QUIET_END_HOUR=8
ENV
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  echo "==> Repairing existing .env"
  if grep -q '^HOST=' "$APP_DIR/.env"; then
    sed -i "s/^HOST=.*/HOST=$PUBLIC_HOST/" "$APP_DIR/.env"
  else
    printf '\nHOST=%s\n' "$PUBLIC_HOST" >> "$APP_DIR/.env"
  fi
  if grep -q '^API_TOKEN=' "$APP_DIR/.env"; then
    sed -i "s|^API_TOKEN=.*|API_TOKEN=$TOKEN|" "$APP_DIR/.env"
  else
    printf 'API_TOKEN=%s\n' "$TOKEN" >> "$APP_DIR/.env"
  fi
  DASHBOARD_USERNAME="$(grep -m1 '^DASHBOARD_USERNAME=' "$APP_DIR/.env" | cut -d= -f2-)"
  DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-gmwebadmin}"
  DASHBOARD_PASSWORD="$(node -e "console.log(require('node:crypto').randomBytes(33).toString('base64url'))")"
  DASHBOARD_PASSWORD_HASH="$(printf '%s' "$DASHBOARD_PASSWORD" | runuser -u "$APP_USER" -- node "$APP_DIR/scripts/hash-password.js" --stdin)"
  if grep -q '^DASHBOARD_PASSWORD_HASH=' "$APP_DIR/.env"; then
    sed -i "s|^DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$DASHBOARD_PASSWORD_HASH|" "$APP_DIR/.env"
  else
    printf 'DASHBOARD_PASSWORD_HASH=%s\n' "$DASHBOARD_PASSWORD_HASH" >> "$APP_DIR/.env"
  fi
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

chmod +x "$APP_DIR/scripts/vps-chrome.sh" "$APP_DIR/scripts/pairing-vnc.sh"
chmod +x "$APP_DIR/scripts/gmweb-menu.sh" "$APP_DIR/scripts/uninstall.sh" "$APP_DIR/scripts/public-dashboard.sh"

echo "==> Installing gmweb command"
ln -sf "$APP_DIR/scripts/gmweb-menu.sh" /usr/local/bin/gmweb
cat > /usr/local/bin/gmweb-uninstall <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb uninstall "$@"
SCRIPT

cat > /usr/local/bin/gmweb-token <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb token "$@"
SCRIPT
cat > /usr/local/bin/gmweb-status <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb status "$@"
SCRIPT
cat > /usr/local/bin/gmweb-smoke <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb smoke "$@"
SCRIPT
cat > /usr/local/bin/gmweb-vnc-on <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb vnc-on "$@"
SCRIPT
cat > /usr/local/bin/gmweb-vnc-off <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb vnc-off "$@"
SCRIPT
chmod +x /usr/local/bin/gmweb-uninstall /usr/local/bin/gmweb-token /usr/local/bin/gmweb-status /usr/local/bin/gmweb-smoke /usr/local/bin/gmweb-vnc-on /usr/local/bin/gmweb-vnc-off

SYSTEMCTL_BIN="$(command -v systemctl)"
echo "==> Installing limited sudo rules for dashboard controls"
cat > /etc/sudoers.d/gmweb-api <<SUDOERS
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN start gmweb-vnc.service gmweb-novnc.service
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN stop gmweb-novnc.service gmweb-vnc.service
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN restart gmweb-api.service
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN restart gmweb-chrome.service
SUDOERS
chmod 440 /etc/sudoers.d/gmweb-api
visudo -cf /etc/sudoers.d/gmweb-api >/dev/null

echo "==> Installing systemd services"
cat > /etc/systemd/system/gmweb-chrome.service <<SERVICE
[Unit]
Description=$APP_NAME Chrome on virtual display
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=ROOT_DIR=$APP_DIR
Environment=USER_DATA_DIR=$APP_DIR/data/browser-profile
Environment=DISPLAY_ID=$DISPLAY_ID
Environment=BROWSER_CDP_PORT=$CDP_PORT
Environment=TZ=$SERVER_TIMEZONE
ExecStart=$APP_DIR/scripts/vps-chrome.sh
CPUAccounting=true
MemoryAccounting=true
CPUWeight=50
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/gmweb-api.service <<SERVICE
[Unit]
Description=$APP_NAME HTTP bridge
After=network.target gmweb-chrome.service
Wants=gmweb-chrome.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=TZ=$SERVER_TIMEZONE
ExecStart=/usr/bin/npm start
CPUAccounting=true
MemoryAccounting=true
CPUWeight=200
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/gmweb-vnc.service <<SERVICE
[Unit]
Description=$APP_NAME pairing VNC bridge
After=gmweb-chrome.service
Wants=gmweb-chrome.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=DISPLAY_ID=$DISPLAY_ID
ExecStart=$APP_DIR/scripts/pairing-vnc.sh
CPUWeight=20
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/gmweb-novnc.service <<SERVICE
[Unit]
Description=$APP_NAME noVNC web bridge
After=gmweb-vnc.service
Wants=gmweb-vnc.service

[Service]
Type=simple
User=$APP_USER
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now gmweb-chrome.service gmweb-api.service
systemctl disable gmweb-vnc.service gmweb-novnc.service 2>/dev/null || true

PUBLIC_URL=""
if [[ "$PUBLIC_DASHBOARD" != "0" && "$PUBLIC_DASHBOARD" != "false" && "$PUBLIC_DASHBOARD" != "no" ]]; then
  echo "==> Configuring public HTTPS access"
  if [[ -z "$PUBLIC_DOMAIN" ]]; then
    PUBLIC_IP="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    if [[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      PUBLIC_DOMAIN="gmweb.${PUBLIC_IP}.nip.io"
    fi
  fi

  if [[ -n "$PUBLIC_DOMAIN" ]]; then
    if GMWEB_DASHBOARD_USER="$DASHBOARD_USERNAME" \
       GMWEB_DASHBOARD_PASS="$DASHBOARD_PASSWORD" \
       bash "$APP_DIR/scripts/public-dashboard.sh" install "$PUBLIC_DOMAIN" "$LETSENCRYPT_EMAIL"; then
      PUBLIC_URL="https://$PUBLIC_DOMAIN"
    else
      echo "Warning: HTTPS setup could not complete. Ensure ports 80 and 443 are open in the VPS/provider firewall, then run:"
      echo "  gmweb public-dashboard install $PUBLIC_DOMAIN ${LETSENCRYPT_EMAIL:-admin@example.com}"
    fi
  else
    echo "Warning: public IPv4 could not be detected; HTTPS setup skipped. Set PUBLIC_DOMAIN and run the installer again."
  fi
fi

echo
echo "==> Installed $APP_NAME"
echo "App directory: $APP_DIR"
echo "API token: $(grep '^API_TOKEN=' "$APP_DIR/.env" | sed 's/API_TOKEN=//')"
echo "Dashboard username: $DASHBOARD_USERNAME"
echo "Dashboard password: $DASHBOARD_PASSWORD"
echo
echo "Manager menu: gmweb"
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "$PUBLIC_URL" ]]; then
  echo "React app: $PUBLIC_URL/app"
  echo "Classic dashboard: $PUBLIC_URL/dashboard"
  echo "API base URL: $PUBLIC_URL"
else
  echo "React app: http://${SERVER_IP:-SERVER_IP}:$APP_PORT/app"
  echo "Classic dashboard: http://${SERVER_IP:-SERVER_IP}:$APP_PORT/dashboard"
  echo "API base URL: http://${SERVER_IP:-SERVER_IP}:$APP_PORT"
fi
echo
echo "Next:"
echo "1) gmweb vnc-on"
echo "2) From your laptop: ssh -L 6080:127.0.0.1:6080 root@SERVER_IP"
echo "3) Open http://127.0.0.1:6080/vnc.html and pair Google Messages"
echo "4) gmweb vnc-off"
echo "5) gmweb smoke"
echo
echo "Optional public dashboard:"
echo "gmweb public-dashboard install dashboard.example.com admin@example.com"
