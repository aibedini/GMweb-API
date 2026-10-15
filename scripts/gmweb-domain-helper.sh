#!/usr/bin/env bash
# gmweb-domain-helper — the ONLY privileged component of domain management.
#
# Installed root:root 0755 at /usr/local/sbin/gmweb-domain-helper and reachable
# by the unprivileged `gmweb` user through exact-subcommand sudoers rules:
#
#   gmweb-domain-helper apply  <hostname> <serviceId>
#   gmweb-domain-helper issue  <hostname> [acme-email]
#   gmweb-domain-helper remove <hostname>
#
# Design rules (spec domain-proxy-ssl-v1):
#   * argv is the whole interface. No path, upstream or nginx text is accepted.
#   * Every argument is re-validated here; the caller's validation is not trusted.
#   * The upstream is the constant below. A serviceId only picks a path surface.
#   * Every nginx change is `nginx -t` gated and rolled back on failure.
#   * Only files carrying our marker are ever modified or removed.
#   * stdout is exactly one JSON line; exit 0 means ok, non-zero means failure.
set -euo pipefail
umask 022

readonly UPSTREAM="127.0.0.1:3030"
readonly MARKER="# managed-by: gmweb-domain-helper"
readonly CERT_TIMEOUT=240

# Test mode: only honoured for a NON-root caller, so it cannot be used to
# redirect a privileged run. Tests point every root-owned location below a
# scratch directory and stub nginx/systemctl/certbot on PATH.
if [[ "$(id -u)" -ne 0 && -n "${GMWEB_HELPER_TEST_ROOT:-}" ]]; then
  ROOT="$GMWEB_HELPER_TEST_ROOT"
  PATH="${GMWEB_HELPER_TEST_STUBS:+$GMWEB_HELPER_TEST_STUBS:}$PATH"
else
  ROOT=""
  PATH="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
fi
export PATH
SITES_AVAILABLE="$ROOT/etc/nginx/sites-available"
SITES_ENABLED="$ROOT/etc/nginx/sites-enabled"
CONF_D="$ROOT/etc/nginx/conf.d"
LIVE_DIR="$ROOT/etc/letsencrypt/live"
LOCK_FILE="$ROOT/var/lock/gmweb-domain-helper.lock"
MAP_FILE="$CONF_D/gmweb-domains-map.conf"

json_escape() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-400; }
ok()   { printf '{"ok":true,"action":"%s","hostname":"%s"}\n' "$1" "$2"; }
fail() { # fail <exit> <CODE> <message>
  printf '{"ok":false,"code":"%s","message":"%s"}\n' "$2" "$(json_escape "$3")"
  exit "$1"
}

valid_host() {
  local h="$1"
  [[ ${#h} -le 253 ]] || return 1
  [[ "$h" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || return 1
  [[ ! "${h##*.}" =~ ^[0-9]+$ ]] || return 1
}
valid_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$ ]]; }

# serviceId -> nginx location blocks. Fixed text; only $UPSTREAM is interpolated.
proxy_block() {
  cat <<BLOCK
    proxy_pass http://$UPSTREAM;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$gmweb_domain_connection_upgrade;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
BLOCK
}
locations_for() {
  case "$1" in
    main-web)
      printf '  location / {\n%s\n  }\n' "$(proxy_block)" ;;
    public-api)
      printf '  location /api/ {\n%s\n  }\n  location = /health {\n%s\n  }\n  location / { return 404; }\n' "$(proxy_block)" "$(proxy_block)" ;;
    admin)
      printf '  location /admin/ {\n%s\n  }\n  location / { return 404; }\n' "$(proxy_block)" ;;
    *) return 1 ;;
  esac
}

site_file() { printf '%s/gmweb-domain-%s.conf' "$SITES_AVAILABLE" "$1"; }
site_link() { printf '%s/gmweb-domain-%s.conf' "$SITES_ENABLED" "$1"; }
has_cert() { [[ -s "$LIVE_DIR/$1/fullchain.pem" && -s "$LIVE_DIR/$1/privkey.pem" ]]; }

render_site() { # render_site <host> <serviceId>
  local host="$1" service="$2" locs
  locs="$(locations_for "$service")"
  if has_cert "$host"; then
    cat <<CONF
$MARKER
# service: $service
server {
  listen 80;
  listen [::]:80;
  server_name $host;
  server_tokens off;
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $host;
  server_tokens off;
  client_max_body_size 20m;
  ssl_certificate $LIVE_DIR/$host/fullchain.pem;
  ssl_certificate_key $LIVE_DIR/$host/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:gmweb_domain_tls:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  add_header Strict-Transport-Security "max-age=31536000" always;
$locs
}
CONF
  else
    cat <<CONF
$MARKER
# service: $service
server {
  listen 80;
  listen [::]:80;
  server_name $host;
  server_tokens off;
  client_max_body_size 20m;
$locs
}
CONF
  fi
}

ensure_map() {
  if [[ -f "$MAP_FILE" ]]; then
    grep -qF "$MARKER" "$MAP_FILE" || fail 5 "FOREIGN_FILE" "A non-managed file occupies the websocket map path."
    return 0
  fi
  mkdir -p "$CONF_D"
  printf '%s\nmap $http_upgrade $gmweb_domain_connection_upgrade {\n  default upgrade;\n  ""      close;\n}\n' "$MARKER" > "$MAP_FILE"
}

foreign_server_name() { # is $1 declared by a conf we do not manage?
  local host="$1" f
  for f in "$SITES_ENABLED"/* "$CONF_D"/*.conf; do
    [[ -e "$f" ]] || continue
    grep -qF "$MARKER" "$f" 2>/dev/null && continue
    if grep -E "^[[:space:]]*server_name[[:space:]]" "$f" 2>/dev/null | tr ' ;' '\n\n' | grep -qxF "$host"; then
      return 0
    fi
  done
  return 1
}

nginx_ready() {
  command -v nginx >/dev/null 2>&1 || fail 4 "NGINX_NOT_INSTALLED" "nginx is not installed on this host."
}
nginx_test() { nginx -t >/dev/null 2>&1; }
nginx_reload() { systemctl reload nginx >/dev/null 2>&1; }

# write_site <host> <serviceId>  — install, test, reload; roll back on failure.
write_site() {
  local host="$1" service="$2" file link backup="" tmp
  file="$(site_file "$host")"; link="$(site_link "$host")"
  mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"
  if [[ -e "$file" ]]; then
    grep -qF "$MARKER" "$file" || fail 5 "FOREIGN_FILE" "A non-managed site file already exists for this hostname."
    backup="$(mktemp)"; cp -p "$file" "$backup"
  fi
  tmp="$(mktemp)"
  render_site "$host" "$service" > "$tmp"
  install -m 644 "$tmp" "$file"; rm -f "$tmp"
  ln -sfn "$file" "$link"
  if ! nginx_test; then
    if [[ -n "$backup" ]]; then install -m 644 "$backup" "$file"; else rm -f "$file" "$link"; fi
    rm -f "$backup"
    fail 3 "NGINX_TEST_FAILED" "nginx rejected the configuration; the previous state was restored."
  fi
  rm -f "$backup"
  if ! nginx_reload; then
    fail 3 "NGINX_RELOAD_FAILED" "nginx configuration is valid but the reload failed."
  fi
}

cmd_apply() {
  local host="${1:-}" service="${2:-}"
  valid_host "$host" || fail 2 "INVALID_HOSTNAME" "Invalid hostname."
  locations_for "$service" >/dev/null 2>&1 || fail 2 "INVALID_SERVICE" "Unknown service."
  nginx_ready
  foreign_server_name "$host" && fail 5 "SERVER_NAME_IN_USE" "Another nginx site already serves this hostname."
  ensure_map
  write_site "$host" "$service"
  ok apply "$host"
}

cmd_issue() {
  local host="${1:-}" email="${2:-}" file service args
  valid_host "$host" || fail 2 "INVALID_HOSTNAME" "Invalid hostname."
  [[ -z "$email" ]] || valid_email "$email" || fail 2 "INVALID_EMAIL" "Invalid e-mail address."
  nginx_ready
  command -v certbot >/dev/null 2>&1 || fail 4 "CERTBOT_NOT_INSTALLED" "certbot is not installed on this host."
  file="$(site_file "$host")"
  [[ -f "$file" ]] && grep -qF "$MARKER" "$file" || fail 6 "NOT_APPLIED" "Apply the domain before requesting a certificate."
  service="$(sed -n 's/^# service: //p' "$file" | head -n1)"
  locations_for "$service" >/dev/null 2>&1 || fail 6 "NOT_APPLIED" "The applied site file is not recognised."
  if ! has_cert "$host"; then
    args=(certonly --nginx -d "$host" --cert-name "$host" --non-interactive --agree-tos --keep-until-expiring
          --deploy-hook "systemctl reload nginx")
    if [[ -n "$email" ]]; then args+=(--email "$email"); else args+=(--register-unsafely-without-email); fi
    local out
    if ! out="$(timeout "$CERT_TIMEOUT" certbot "${args[@]}" 2>&1)"; then
      fail 7 "CERTBOT_FAILED" "$(printf '%s' "$out" | tail -n 4)"
    fi
  fi
  has_cert "$host" || fail 7 "CERTBOT_NO_CERT" "certbot finished but no certificate was found."
  write_site "$host" "$service"
  ok issue "$host"
}

cmd_remove() {
  local host="${1:-}" file link
  valid_host "$host" || fail 2 "INVALID_HOSTNAME" "Invalid hostname."
  nginx_ready
  file="$(site_file "$host")"; link="$(site_link "$host")"
  if [[ ! -e "$file" ]]; then ok remove "$host"; return 0; fi
  grep -qF "$MARKER" "$file" || fail 5 "FOREIGN_FILE" "Refusing to remove a non-managed site file."
  local backup; backup="$(mktemp)"; cp -p "$file" "$backup"
  rm -f "$file" "$link"
  if ! nginx_test; then
    install -m 644 "$backup" "$file"; ln -sfn "$file" "$link"; rm -f "$backup"
    fail 3 "NGINX_TEST_FAILED" "nginx rejected the configuration after removal; the previous state was restored."
  fi
  rm -f "$backup"
  nginx_reload || fail 3 "NGINX_RELOAD_FAILED" "The site was removed but the nginx reload failed."
  ok remove "$host"
}

main() {
  local action="${1:-}"
  [[ $# -le 3 ]] || fail 2 "USAGE" "Too many arguments."
  case "$action" in apply|issue|remove) ;; *) fail 2 "USAGE" "Unknown action." ;; esac
  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -w 30 9 || fail 8 "BUSY" "Another domain operation is running."
  shift
  case "$action" in
    apply)  cmd_apply "$@" ;;
    issue)  cmd_issue "$@" ;;
    remove) cmd_remove "$@" ;;
  esac
}
main "$@"
