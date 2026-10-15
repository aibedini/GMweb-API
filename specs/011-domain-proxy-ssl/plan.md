# Plan — domain-proxy-ssl-v1

1. `scripts/gmweb-domain-helper.sh` (root, `/usr/local/sbin/gmweb-domain-helper`): `apply|issue|remove`, JSON on stdout, exit codes mapped to stable error codes. Test mode (`GMWEB_HELPER_TEST_ROOT`) is honoured only when not root.
2. `scripts/install-domain-helper.sh`: installs the helper (root:root 0755), a validated sudoers drop-in (exact subcommands), optionally nginx + certbot.
3. `src/domainPrivileged.js`: helper client (`sudo -n`, `execFile`, no shell, timeout, mutex, probe cached 60 s, output sanitised).
4. `src/domainStore.js`: additive columns `proxy_status`, `proxy_service_id`, `proxy_applied_at`; `recordProxy`.
5. `src/domainRoutes.js`: `POST /admin/domains/:id/apply`, `POST /admin/domains/:id/issue-certificate`; DELETE removes proxy first; `present()` exposes `proxy`; capability from the helper probe.
6. UI: Domains card enables Apply and Get SSL from capability and proxy state.
7. Tests: helper under a fake nginx/certbot (Linux/bash), client unit tests, route tests with an injected helper, hostile-input tests, honesty tests (certbot ok + failing probe => not SSL_ACTIVE).
8. Version 0.19.51, OpenAPI regenerated, docs (DEPLOYMENT.md, INTEGRATION.md note), front-ends rebuilt.
