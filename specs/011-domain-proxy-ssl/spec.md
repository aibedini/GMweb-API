# Domain proxy and SSL (Phase 2)

Feature ID: domain-proxy-ssl-v1. Scope: GMweb-API only. Builds on `domain-management` Phase 1 (verification only, 0.19.49).

An operator can, from Settings, add a domain, assign it to a service, **apply** it to the host's web server, and **obtain a Let's Encrypt certificate** for it. The unprivileged `gmweb` API process cannot write `/etc/nginx` or run certbot, so these two actions are performed by a separate, root-owned, allowlist-only **privileged helper** reached through a narrow sudoers rule. The API remains unprivileged.

## Requirements

- R1. The helper accepts only `apply|issue|remove`, a syntactically valid hostname, a serviceId from a fixed allowlist, and an optional ACME e-mail. It never receives a path, an upstream, or free-form nginx text. It re-validates everything the API already validated.
- R2. The upstream is always `127.0.0.1:3030`; the service selects only a path surface (`/`, `/api/`+`/health`, `/admin/`). No user input reaches an nginx directive except the validated hostname.
- R3. Every nginx change is `nginx -t` gated. A failing test restores the previous file (or removes the new one) and reports failure; nginx is reloaded only after a passing test.
- R4. The helper only touches files it created (marker line) and refuses a hostname already served by a foreign `server_name`.
- R5. Calls are serialised (in-process mutex and `flock`), time-limited, and run without a shell.
- R6. **Honest outcomes.** A zero exit from certbot is never reported as SSL active. After issuance the API re-runs the TLS/HTTP probe and only that observation can produce `SSL_ACTIVE`.
- R7. Issuance is refused unless DNS was verified OK and the proxy was applied for the currently assigned service.
- R8. Changing a domain's service after apply marks the proxy `STALE` (re-apply required); it is never silently reported as applied.
- R9. Removing an applied domain removes its proxy config first; if that fails the row is kept. Certificates are retained.
- R10. Capability is reported truthfully: `canConfigureProxy`/`canIssueCertificate` are true only if the helper is installed and sudo permits it. Otherwise the UI stays verification-only.
- R11. Private keys, filesystem paths and raw certbot output are never returned by the API; helper messages are truncated and sanitised. Every action is recorded in `domain_operations`.
- R12. Renewal uses certbot's own timer with a `systemctl reload nginx` deploy hook.

## Non-goals

Wildcard certificates (DNS-01), HTTP/3, multi-upstream routing, automatic helper installation by the API, DNS provider integration.

## NOT VERIFIED until run on a real host

Real nginx reload, a real Let's Encrypt issuance, renewal after ~60 days, behaviour behind a firewall that blocks port 80.
