#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-GMweb API}"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
API_SERVICE="${API_SERVICE:-gmweb-api.service}"
CHROME_SERVICE="${CHROME_SERVICE:-gmweb-chrome.service}"
VNC_SERVICE="${VNC_SERVICE:-gmweb-vnc.service}"
NOVNC_SERVICE="${NOVNC_SERVICE:-gmweb-novnc.service}"
API_URL="${API_URL:-http://127.0.0.1:3030}"
STATE_DIR="${STATE_DIR:-/var/lib/gmweb}"
API_TOKEN_FILE="${API_TOKEN_FILE:-$STATE_DIR/api-token.txt}"
DASHBOARD_PASSWORD_FILE="${DASHBOARD_PASSWORD_FILE:-$STATE_DIR/dashboard-password.txt}"
DASHBOARD_CREDENTIALS_FILE="${DASHBOARD_CREDENTIALS_FILE:-/root/gmweb-api-dashboard-login.txt}"
REPO_URL="${REPO_URL:-https://github.com/aibedini/GMweb-API.git}"
UPDATE_DRAIN_TIMEOUT_SECONDS="${UPDATE_DRAIN_TIMEOUT_SECONDS:-300}"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
else
  C_RESET=""
  C_BOLD=""
  C_BLUE=""
  C_CYAN=""
  C_GREEN=""
  C_RED=""
  C_YELLOW=""
fi

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E "$0" "$@"
  fi
  echo "Run as root: sudo gmweb $*"
  exit 1
}

pause() {
  if [[ -t 0 ]]; then
    echo
    read -r -p "Press Enter to continue..." _
  fi
}

token() {
  if [[ -f "$APP_DIR/.env" ]]; then
    grep '^API_TOKEN=' "$APP_DIR/.env" | tail -n 1 | sed 's/^API_TOKEN=//'
  fi
}

env_value() {
  local key="$1"
  if [[ -f "$APP_DIR/.env" ]]; then
    grep -m1 "^${key}=" "$APP_DIR/.env" | cut -d= -f2-
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local env_file="$APP_DIR/.env"
  local tmp found=0 line

  [[ -f "$env_file" ]] || {
    echo "Missing environment file: $env_file"
    return 1
  }
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "$key cannot contain a newline."
    return 1
  }

  tmp="$(mktemp "$APP_DIR/.env.gmweb.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      if [[ "$found" -eq 0 ]]; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
        found=1
      fi
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$env_file"
  if [[ "$found" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chown "$APP_USER:$APP_USER" "$tmp" 2>/dev/null || true
  chmod 600 "$tmp"
  mv -f "$tmp" "$env_file"
}

random_dashboard_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n'
  else
    node -e "console.log(require('node:crypto').randomBytes(33).toString('base64url'))"
  fi
}

random_api_token() {
  if [[ -f "$APP_DIR/scripts/new-token.js" ]]; then
    run_as_app "cd '$APP_DIR' && node scripts/new-token.js"
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
  else
    echo "Cannot generate an API token: Node.js and OpenSSL are unavailable." >&2
    return 1
  fi
}

api_accepts_token() {
  local api_token="$1"
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 2 --max-time 5 \
    -H "Authorization: Bearer $api_token" \
    "$API_URL/admin/overview" 2>/dev/null || true)"
  [[ "$status" == "200" ]]
}

wait_for_api_token() {
  local api_token="$1"
  local attempt
  for attempt in {1..20}; do
    if api_accepts_token "$api_token"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

save_api_token_file() {
  local api_token="$1"
  mkdir -p "$STATE_DIR"
  printf '%s' "$api_token" > "$API_TOKEN_FILE"
  chmod 600 "$API_TOKEN_FILE"
}

rotate_api_token() {
  need_root "$@"
  local old_token new_token
  old_token="$(token || true)"
  [[ -n "$old_token" ]] || {
    echo "${C_RED}No API_TOKEN found in $APP_DIR/.env${C_RESET}"
    return 1
  }

  new_token="$(random_api_token)"
  [[ -n "$new_token" ]] || {
    echo "${C_RED}Token generation failed.${C_RESET}"
    return 1
  }

  set_env_value API_TOKEN "$new_token"
  if ! systemctl restart "$API_SERVICE" || ! wait_for_api_token "$new_token"; then
    echo "${C_RED}The new token did not become active; restoring the previous token.${C_RESET}" >&2
    set_env_value API_TOKEN "$old_token"
    systemctl restart "$API_SERVICE" || true
    wait_for_api_token "$old_token" || true
    return 1
  fi

  save_api_token_file "$new_token"
  echo "${C_GREEN}API token rotated and verified.${C_RESET}"
  echo "API token: $new_token"
  echo
  echo "${C_YELLOW}Existing dashboard sessions and API clients must use this new token.${C_RESET}"
}

hash_dashboard_password() {
  local password="$1"
  if id "$APP_USER" >/dev/null 2>&1; then
    printf '%s' "$password" | runuser -u "$APP_USER" -- node "$APP_DIR/scripts/hash-password.js" --stdin
  else
    printf '%s' "$password" | node "$APP_DIR/scripts/hash-password.js" --stdin
  fi
}

save_dashboard_credentials() {
  local username="$1"
  local password="$2"
  local hash

  [[ -n "$username" ]] || { echo "Dashboard username cannot be empty."; return 1; }
  [[ ${#username} -le 128 ]] || { echo "Dashboard username must be at most 128 characters."; return 1; }
  [[ "$username" != *$'\n'* && "$username" != *$'\r'* ]] || {
    echo "Dashboard username cannot contain a newline."
    return 1
  }
  [[ -n "$password" ]] || { echo "Dashboard password cannot be empty."; return 1; }
  [[ ${#password} -le 512 ]] || { echo "Dashboard password must be at most 512 characters."; return 1; }

  hash="$(hash_dashboard_password "$password")"
  set_env_value DASHBOARD_USERNAME "$username"
  set_env_value DASHBOARD_PASSWORD_HASH "$hash"

  mkdir -p "$STATE_DIR"
  printf '%s' "$password" > "$DASHBOARD_PASSWORD_FILE"
  chmod 600 "$DASHBOARD_PASSWORD_FILE"
  if [[ -f "$DASHBOARD_CREDENTIALS_FILE" ]]; then
    local dashboard_url
    dashboard_url="$(grep -m1 '^URL=' "$DASHBOARD_CREDENTIALS_FILE" | cut -d= -f2- || true)"
    {
      [[ -z "$dashboard_url" ]] || printf 'URL=%s\n' "$dashboard_url"
      printf 'USERNAME=%s\n' "$username"
      printf 'PASSWORD=%s\n' "$password"
    } > "$DASHBOARD_CREDENTIALS_FILE"
    chmod 600 "$DASHBOARD_CREDENTIALS_FILE"
  fi
  systemctl restart "$API_SERVICE"

  echo "${C_GREEN}Dashboard credentials updated.${C_RESET}"
  echo "Username: $username"
  echo "Password: $password"
  echo
  echo "${C_YELLOW}Existing dashboard sessions may need to sign in again.${C_RESET}"
}

dashboard_credentials() {
  need_root "$@"
  local current_user mode username password first second
  current_user="$(env_value DASHBOARD_USERNAME || true)"
  current_user="${current_user:-gmwebadmin}"

  if [[ ! -t 0 ]]; then
    echo "Interactive terminal required. Run: gmweb credentials"
    return 2
  fi

  echo "${C_BOLD}${C_BLUE}Dashboard credentials${C_RESET}"
  echo
  echo "Current username: $current_user"
  echo
  echo "  1) Keep username; generate a new password"
  echo "  2) Set username; generate a new password"
  echo "  3) Keep username; choose a new password"
  echo "  4) Set username and choose a new password"
  echo "  0) Cancel"
  echo
  read -r -p "Select: " mode

  case "$mode" in
    1)
      username="$current_user"
      password="$(random_dashboard_password)"
      ;;
    2)
      read -r -p "New username: " username
      password="$(random_dashboard_password)"
      ;;
    3)
      username="$current_user"
      read -r -s -p "New password: " first; echo
      read -r -s -p "Confirm password: " second; echo
      [[ "$first" == "$second" ]] || { echo "${C_RED}Passwords do not match.${C_RESET}"; return 1; }
      password="$first"
      ;;
    4)
      read -r -p "New username: " username
      read -r -s -p "New password: " first; echo
      read -r -s -p "Confirm password: " second; echo
      [[ "$first" == "$second" ]] || { echo "${C_RED}Passwords do not match.${C_RESET}"; return 1; }
      password="$first"
      ;;
    0) return 0 ;;
    *) echo "${C_RED}Invalid option.${C_RESET}"; return 2 ;;
  esac

  save_dashboard_credentials "$username" "$password"
}

run_as_app() {
  if id "$APP_USER" >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- bash -lc "$*"
  else
    bash -lc "$*"
  fi
}

service_state() {
  local service="$1"
  local active enabled
  active="$(systemctl is-active "$service" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$service" 2>/dev/null || true)"
  printf "%-22s active=%-10s enabled=%s\n" "$service" "${active:-unknown}" "${enabled:-unknown}"
}

ready_check() {
  local api_token
  api_token="$(token || true)"
  if [[ -z "$api_token" ]]; then
    echo "No API_TOKEN found in $APP_DIR/.env"
    return 1
  fi
  curl -fsS -H "Authorization: Bearer $api_token" "$API_URL/ready" || true
}

status() {
  echo "${C_BOLD}${C_BLUE}$APP_NAME status${C_RESET}"
  echo
  service_state "$CHROME_SERVICE"
  service_state "$API_SERVICE"
  service_state "$VNC_SERVICE"
  service_state "$NOVNC_SERVICE"
  echo
  echo "App directory: $APP_DIR"
  echo "API URL:       $API_URL"
  echo "Dashboard:    $API_URL/dashboard"
  if [[ -n "$(token || true)" ]]; then
    echo "API token:     configured"
  else
    echo "API token:     missing"
  fi
  echo
  echo "${C_CYAN}Listening ports${C_RESET}"
  ss -ltnp 2>/dev/null | grep -E ':(3030|9222|6080|5900)\b' || echo "No GMweb ports are listening."
  echo
  echo "${C_CYAN}Readiness${C_RESET}"
  ready_check
  echo
}

start_services() {
  need_root "$@"
  systemctl start "$CHROME_SERVICE"
  systemctl start "$API_SERVICE"
  echo "${C_GREEN}Chrome and API started.${C_RESET}"
}

stop_services() {
  need_root "$@"
  systemctl stop "$API_SERVICE" "$CHROME_SERVICE" 2>/dev/null || true
  echo "${C_YELLOW}Chrome and API stopped.${C_RESET}"
}

restart_api() {
  need_root "$@"
  systemctl restart "$API_SERVICE"
  echo "${C_GREEN}API restarted.${C_RESET}"
}

restart_chrome() {
  need_root "$@"
  systemctl restart "$CHROME_SERVICE"
  sleep 2
  systemctl restart "$API_SERVICE"
  echo "${C_GREEN}Chrome and API restarted.${C_RESET}"
}

vnc_on() {
  need_root "$@"
  systemctl start "$VNC_SERVICE" "$NOVNC_SERVICE"
  echo "${C_GREEN}VNC/noVNC is on.${C_RESET}"
  echo "Tunnel from your computer:"
  echo "  ssh -L 6080:127.0.0.1:6080 root@SERVER_IP"
  echo "Then open:"
  echo "  http://127.0.0.1:6080/vnc.html"
}

vnc_off() {
  need_root "$@"
  systemctl stop "$NOVNC_SERVICE" "$VNC_SERVICE" 2>/dev/null || true
  echo "${C_GREEN}VNC/noVNC is off.${C_RESET}"
}

show_token() {
  local api_token
  api_token="$(token || true)"
  if [[ -z "$api_token" ]]; then
    echo "No API_TOKEN found in $APP_DIR/.env"
    return 1
  fi
  echo "$api_token"
}

smoke() {
  need_root "$@"
  run_as_app "cd '$APP_DIR' && npm run smoke"
}

logs() {
  need_root "$@"
  local target="${1:-api}"
  local service="$API_SERVICE"

  case "$target" in
    api) service="$API_SERVICE" ;;
    chrome) service="$CHROME_SERVICE" ;;
    vnc) service="$VNC_SERVICE" ;;
    novnc) service="$NOVNC_SERVICE" ;;
    *)
      echo "Usage: gmweb logs [api|chrome|vnc|novnc]"
      return 2
      ;;
  esac

  journalctl -u "$service" -n 120 -f
}

queue_snapshot() {
  local api_token
  api_token="$(token || true)"
  [[ -n "$api_token" ]] || return 1
  curl -fsS --max-time 10 -H "Authorization: Bearer $api_token" "$API_URL/admin/queue"
}

queue_snapshot_value() {
  local expression="$1"
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        if (process.argv[1] === "paused") process.stdout.write(data.paused ? "true" : "false");
        else process.stdout.write(String(Number(data.counts?.active || 0)));
      } catch { process.exit(1); }
    });
  ' "$expression"
}

queue_control() {
  local action="$1" api_token
  api_token="$(token || true)"
  [[ -n "$api_token" ]] || return 1
  curl -fsS --max-time 15 -X POST \
    -H "Authorization: Bearer $api_token" \
    -H "Content-Type: application/json" \
    -d '{}' "$API_URL/admin/queue/$action" >/dev/null
}

pause_and_drain_queue() {
  local snapshot active waited=0
  snapshot="$(queue_snapshot)" || {
    echo "${C_RED}Cannot inspect the queue; refusing a migration without send-safety checks.${C_RESET}"
    return 1
  }
  UPDATE_QUEUE_WAS_PAUSED="$(printf '%s' "$snapshot" | queue_snapshot_value paused)"
  queue_control pause
  echo "Queue paused; waiting for the active send to finish..."

  while (( waited < UPDATE_DRAIN_TIMEOUT_SECONDS )); do
    snapshot="$(queue_snapshot)" || return 1
    active="$(printf '%s' "$snapshot" | queue_snapshot_value active)"
    if (( active == 0 )); then
      echo "${C_GREEN}Queue drained safely.${C_RESET}"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "${C_RED}Active send did not finish within ${UPDATE_DRAIN_TIMEOUT_SECONDS}s; migration cancelled.${C_RESET}"
  [[ "$UPDATE_QUEUE_WAS_PAUSED" == "true" ]] || queue_control resume || true
  return 1
}

wait_for_api_ready() {
  local api_token waited=0 response
  api_token="$(token || true)"
  [[ -n "$api_token" ]] || return 1
  while (( waited < 90 )); do
    response="$(curl -fsS --max-time 8 -H "Authorization: Bearer $api_token" "$API_URL/ready" 2>/dev/null || true)"
    if printf '%s' "$response" | node -e '
      let raw=""; process.stdin.on("data", c => raw += c);
      process.stdin.on("end", () => { try { process.exit(JSON.parse(raw).ready === true ? 0 : 1); } catch { process.exit(1); } });
    '; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

adopt_git_checkout() {
  local stamp app_parent stage previous backup failed data_kb free_kb required_kb
  stamp="$(date +%Y%m%d-%H%M%S)"
  app_parent="$(dirname "$APP_DIR")"
  stage="$app_parent/.gmweb-update-stage-$stamp"
  previous="$APP_DIR.previous-$stamp"
  backup="/var/backups/gmweb/$stamp"
  failed="$APP_DIR.failed-$stamp"
  UPDATE_QUEUE_WAS_PAUSED="true"

  echo "Archive installation detected; converting it to a managed Git checkout."
  echo "Repository: $REPO_URL"
  [[ -f "$APP_DIR/.env" && -d "$APP_DIR/data" ]] || {
    echo "${C_RED}Missing $APP_DIR/.env or $APP_DIR/data; refusing migration.${C_RESET}"
    return 1
  }
  if ! git ls-remote --exit-code "$REPO_URL" refs/heads/main >/dev/null; then
    echo "${C_RED}Cannot reach the main branch at $REPO_URL; existing installation was not changed.${C_RESET}"
    return 1
  fi
  if ! git clone --branch main --single-branch "$REPO_URL" "$stage"; then
    case "$stage" in "$app_parent"/.gmweb-update-stage-*) rm -rf -- "$stage" ;; esac
    return 1
  fi
  chown -R "$APP_USER:$APP_USER" "$stage"
  if ! run_as_app "cd '$stage' && npm ci --omit=dev" || ! run_as_app "cd '$stage' && npm run check"; then
    echo "${C_RED}The new release failed validation; existing installation was not changed.${C_RESET}"
    case "$stage" in "$app_parent"/.gmweb-update-stage-*) rm -rf -- "$stage" ;; esac
    return 1
  fi

  data_kb="$(du -sk "$APP_DIR/data" | awk '{print $1}')"
  free_kb="$(df -Pk "$app_parent" | awk 'NR==2 {print $4}')"
  required_kb=$((data_kb * 2 + 524288))
  if (( free_kb < required_kb )); then
    echo "${C_RED}Not enough disk for two safety copies of data/. Need about $((required_kb / 1024)) MB free.${C_RESET}"
    case "$stage" in "$app_parent"/.gmweb-update-stage-*) rm -rf -- "$stage" ;; esac
    return 1
  fi

  if ! pause_and_drain_queue; then
    case "$stage" in "$app_parent"/.gmweb-update-stage-*) rm -rf -- "$stage" ;; esac
    return 1
  fi

  if (
    set -e
    systemctl stop "$API_SERVICE"
    systemctl stop "$CHROME_SERVICE"

    install -d -m 700 "$backup"
    cp -a "$APP_DIR/.env" "$backup/.env"
    cp -a "$APP_DIR/data" "$backup/data"
    [[ ! -d "$STATE_DIR" ]] || cp -a "$STATE_DIR" "$backup/state-dir"
    test -s "$backup/.env"
    test -d "$backup/data"

    cp -a "$APP_DIR/.env" "$stage/.env"
    cp -a "$APP_DIR/data" "$stage/data"
    chown -R "$APP_USER:$APP_USER" "$stage"
    chmod 600 "$stage/.env"

    mv "$APP_DIR" "$previous"
    mv "$stage" "$APP_DIR"
    install -m 0755 "$APP_DIR/scripts/gmweb-menu.sh" /usr/local/bin/gmweb

    systemctl start "$CHROME_SERVICE"
    sleep 2
    systemctl start "$API_SERVICE"
    wait_for_api_ready
  ); then
    if [[ "$UPDATE_QUEUE_WAS_PAUSED" != "true" ]] && ! queue_control resume; then
      echo "${C_YELLOW}Update succeeded, but the queue could not be resumed automatically. Resume it from Dashboard -> Queue.${C_RESET}"
    fi
    echo "${C_GREEN}Converted to Git checkout and updated successfully.${C_RESET}"
    echo "Data backup:      $backup"
    echo "Previous install: $previous"
    echo "Future updates:   sudo gmweb update"
    return 0
  else
    echo "${C_RED}Migration failed; rolling back automatically.${C_RESET}"
    systemctl stop "$API_SERVICE" "$CHROME_SERVICE" 2>/dev/null || true
    if [[ -d "$previous" ]]; then
      [[ ! -e "$APP_DIR" ]] || mv "$APP_DIR" "$failed"
      mv "$previous" "$APP_DIR"
      [[ ! -x "$APP_DIR/scripts/gmweb-menu.sh" ]] || install -m 0755 "$APP_DIR/scripts/gmweb-menu.sh" /usr/local/bin/gmweb
    fi
    systemctl start "$CHROME_SERVICE"
    sleep 2
    systemctl start "$API_SERVICE"
    [[ "$UPDATE_QUEUE_WAS_PAUSED" == "true" ]] || { sleep 2; queue_control resume || true; }
    echo "Rollback complete. Existing data remains at $APP_DIR."
    [[ ! -d "$failed" ]] || echo "Failed release kept at $failed"
    return 1
  fi
}

update_app() {
  need_root "$@"
  if [[ ! -d "$APP_DIR/.git" ]]; then
    adopt_git_checkout
    return
  fi

  run_as_app "git -C '$APP_DIR' pull --ff-only"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  run_as_app "cd '$APP_DIR' && npm ci --omit=dev"
  systemctl restart "$API_SERVICE"
  wait_for_api_ready || {
    echo "${C_RED}API restarted but did not become ready. Check: journalctl -u $API_SERVICE -n 100${C_RESET}"
    return 1
  }
  echo "${C_GREEN}Updated and restarted API.${C_RESET}"
}

uninstall_app() {
  need_root "$@"
  if [[ -x "$APP_DIR/scripts/uninstall.sh" ]]; then
    "$APP_DIR/scripts/uninstall.sh"
  else
    echo "Uninstaller not found: $APP_DIR/scripts/uninstall.sh"
    return 1
  fi
}

public_dashboard() {
  need_root "$@"
  if [[ -x "$APP_DIR/scripts/public-dashboard.sh" ]]; then
    "$APP_DIR/scripts/public-dashboard.sh" "$@"
  else
    echo "Public dashboard helper not found: $APP_DIR/scripts/public-dashboard.sh"
    return 1
  fi
}

render_menu() {
  clear || true
  echo "${C_BOLD}${C_BLUE}GMweb API Manager${C_RESET}"
  echo "${C_CYAN}$(hostname)${C_RESET}"
  echo
  echo "  1) Status / readiness"
  echo "  2) Smoke test"
  echo "  3) Restart API"
  echo "  4) Restart Chrome + API"
  echo "  5) Start Chrome + API"
  echo "  6) Stop Chrome + API"
  echo "  7) Turn VNC/noVNC on"
  echo "  8) Turn VNC/noVNC off"
  echo "  9) Show API token"
  echo " 10) Logs"
  echo " 11) Safe update / connect old install to Git"
  echo " 12) Uninstall GMweb API"
  echo " 13) Public dashboard setup"
  echo " 14) Reset dashboard username / password"
  echo " 15) Generate and activate a new API token"
  echo "  0) Exit"
  echo
}

menu_loop() {
  need_root "$@"
  while true; do
    render_menu
    read -r -p "Select: " choice
    echo
    case "$choice" in
      1) status; pause ;;
      2) smoke; pause ;;
      3) restart_api; pause ;;
      4) restart_chrome; pause ;;
      5) start_services; pause ;;
      6) stop_services; pause ;;
      7) vnc_on; pause ;;
      8) vnc_off; pause ;;
      9) show_token; pause ;;
      10)
        echo "api, chrome, vnc, novnc"
        read -r -p "Log target [api]: " target
        logs "${target:-api}"
        ;;
      11) update_app; pause ;;
      12) uninstall_app; exit 0 ;;
      13)
        read -r -p "Domain: " domain
        read -r -p "Email for Let's Encrypt [optional]: " email
        public_dashboard install "$domain" "$email"
        pause
        ;;
      14) dashboard_credentials; pause ;;
      15)
        read -r -p "Rotate the API token? Existing clients will stop working [y/N]: " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
          rotate_api_token
        else
          echo "Cancelled."
        fi
        pause
        ;;
      0) exit 0 ;;
      *) echo "${C_RED}Invalid option.${C_RESET}"; pause ;;
    esac
  done
}

cmd="${1:-menu}"
shift || true

case "$cmd" in
  menu) menu_loop "$@" ;;
  status) status "$@" ;;
  ready) ready_check "$@" ;;
  smoke) smoke "$@" ;;
  start) start_services "$@" ;;
  stop) stop_services "$@" ;;
  restart|restart-api) restart_api "$@" ;;
  restart-chrome|chrome-restart) restart_chrome "$@" ;;
  vnc-on) vnc_on "$@" ;;
  vnc-off) vnc_off "$@" ;;
  token) show_token "$@" ;;
  token-reset|rotate-token) rotate_api_token "$@" ;;
  logs) logs "$@" ;;
  update) update_app "$@" ;;
  uninstall) uninstall_app "$@" ;;
  public-dashboard) public_dashboard "$@" ;;
  credentials|dashboard-credentials) dashboard_credentials "$@" ;;
  -h|--help|help)
    cat <<HELP
Usage: gmweb [command]

Commands:
  menu             Open interactive menu
  status           Show services, ports, and /ready
  ready            Print /ready response
  smoke            Run no-send smoke test
  start            Start Chrome and API
  stop             Stop Chrome and API
  restart          Restart API
  restart-chrome   Restart Chrome and API
  vnc-on           Start temporary noVNC pairing access
  vnc-off          Stop noVNC pairing access
  token            Print API token
  token-reset      Generate, activate, and verify a new API token
  logs [target]    Follow logs: api, chrome, vnc, novnc
  update           Safe update; converts archive installs to Git once
  uninstall        Remove GMweb API from the server
  public-dashboard Manage public HTTPS dashboard exposure
  credentials      Reset dashboard username/password interactively
HELP
    ;;
  *)
    echo "Unknown command: $cmd"
    echo "Run: gmweb help"
    exit 2
    ;;
esac
