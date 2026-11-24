# Bug Verification: headless apt for the installer

- **Slug:** interactive-apt-dialog
- **Result:** verified on the affected host — the install that used to hang completed, and
  needrestart printed its list instead of opening the blocking dialog.

## Production acceptance (94.184.30.180, 2026-11-24)

Host: Ubuntu 22.04.5 LTS, 2 vCPU, 1.9 GB RAM, `needrestart 3.5-5ubuntu2.5` (the exact
package whose apt hook draws the dialog). Installer: `install/ubuntu22.sh` from `main`
(`PUBLIC_DOMAIN=irgm.okgfx.ir`), run over a non-interactive SSH session.

| Check | Evidence |
| --- | --- |
| No dialog, list-only instead | `install.log` contains the restart list (`...ed-upgrades.service`, `No containers need to be restarted.`) and the install continued |
| Install finished | `==> Installed GMweb API`, `systemctl is-active gmweb-api gmweb-chrome nginx redis-server` → all `active` |
| API on the domain | `GET https://irgm.okgfx.ir/health` → 200, `{"ok":true,"version":"0.20.8"}` (checked from an external machine) |
| React console / dashboard | `GET /app` → 200, `GET /dashboard` → 200, `GET /` → 301 to HTTPS |
| Certificate | `CN = irgm.okgfx.ir`, `notBefore Nov 24 2026`, `notAfter Feb 22 2027` |
| Dashboard auth + VNC proxy | `POST /dashboard/password-login` → 200, `POST /dashboard/login` → 200, `GET /vnc/vnc.html` with the session cookie → 200 |
| Survives reboot | after `systemctl reboot`: all four services active, HTTPS health 200 |
| Firewall | `ufw` active, only 22/80/443 allowed; the API's 3030 is no longer reachable from outside |

Additional hardening applied on that host: 2 GB swap file (Chrome on a 1.9 GB box).

## Not verified

- Google Messages QR pairing. On this host Google now requires signing in to the Google
  account before it shows the pairing QR, so the account owner has to do it inside the VNC
  console (`https://irgm.okgfx.ir/dashboard` → VNC, or an SSH tunnel to `127.0.0.1:6080`).
  The API correctly reports `"state":"not_paired","reason":"chrome_not_paired"` until then.

## Defects found and fixed during that deployment

1. **Reattaching stdin broke the documented piped install.** The first guard used
   `-r /dev/tty` and then `exec </dev/tty`; without a controlling terminal the open fails
   with ENXIO and `set -e` aborts the script. The second version probed `/dev/tty` in a
   subshell first, which is worse for the documented `curl … | sudo bash`: bash reads the
   **script** from fd 0, so the `exec` sends the parser to the terminal and every remaining
   line is lost. Measured with a 42 KB piped script on the host: `START` then nothing, no
   exit. The same script without the `exec` prints `START`, `END`, `RC=0`. Final design: no
   stdin reattachment at all; only each `apt` call gets `</dev/null`, and menu prompts keep
   reading `/dev/tty` directly.
2. **Backticks in unquoted heredoc comments executed commands.** The `gmweb-api.service`
   heredoc needs `$APP_DIR`, so it is unquoted; a comment written as `` `npm start` `` ran
   npm from `/root` during the install and `` `.env` `` produced a "command not found".
   The backticks are escaped and a test parses every unquoted heredoc body and rejects
   backticks in comment lines.

## Local verification

| Evidence | Command | Result |
| --- | --- | --- |
| Syntax, all touched bash | `bash -n` (Git Bash and Ubuntu 22.04.5) | 6/6 OK |
| Installer contract (static + behavioural) | `node --test test/installerHeadlessApt.test.js` | 10/10 pass |
| Helper behaviour on Ubuntu 22.04 bash | probe sources the real `install/quick-install.sh` with stubbed `apt-get`/`dpkg` | `mode=l tty=no stdin=/dev/null`, `-y`, bounded lock, `dpkg --configure -a` |
| JS syntax | `npm run check` | exit 0 |
| Unit/contract suite | `npm test` | 988 tests, 987 pass, 0 fail, 1 skipped |

`NEEDRESTART_MODE` and the `conf.d` drop-in were confirmed against the Ubuntu package
itself: `needrestart` 3.5 reads `/etc/needrestart/conf.d/*.conf` via `eval do { ... }` and
resolves the mode with `$opt_r = $ENV{NEEDRESTART_MODE} ...; $opt_r = $nrconf{restart}
unless defined`. With `-t` absent it also falls back to list mode.

## Note on the local full-suite run

The first `npm test` on the development checkout failed only
`test/frontendArtifacts.test.js`: `PWA build-info version drift: 0.20.0 != 0.20.8`.
`public/web-app/build-info.json` is a git-ignored local build artifact from an older build
and is absent from CI checkouts; removing it made the suite pass 987/987 with 1 skip.
