# GMweb API Operations

## Tehran timezone and quiet hours

Installers set the Linux server timezone to `Asia/Tehran`. The send worker also
uses that timezone explicitly: normal-priority SMS jobs are durably delayed from
02:00 through 07:59 and released at 08:00. Only fresh HIGH first attempts bypass
this rule; delayed/retrying jobs are held until 08:00 even when HIGH.
The defaults can be changed with `SEND_TIMEZONE`, `SEND_QUIET_START_HOUR`, and
`SEND_QUIET_END_HOUR`.

## Browser automation health and automatic recovery

`gmweb-monitor.timer` runs every two minutes. In addition to `/health` and
`/ready`, it launches `scripts/browser-probe.js`, which opens an independent
Playwright CDP connection and evaluates a tiny expression in the real Google
Messages page. This detects the otherwise invisible failure where VNC still
paints and `/ready` returns cached `paired:true`, but Chrome no longer accepts
automation commands. Two consecutive failed probes restart `gmweb-chrome` and
`gmweb-api`. A send-level browser/lock timeout triggers the same recovery
immediately, with a persistent five-minute cooldown.

Send-time recovery is stage-aware. A `checking_paired` failure occurs before
the composer is touched, so GMweb safely reloads the conversations page,
reconnects Playwright, checks pairing again, and lets BullMQ retry the queued
message. If the session is still unready, or a `browser_unresponsive` timeout
shows that CDP itself is wedged, GMweb restarts `gmweb-chrome` and `gmweb-api`.
The persistent five-minute cooldown prevents restart loops; a genuinely
unpaired phone still requires an operator to scan the QR code.

Recovery evidence is available in three places:

- `journalctl -u gmweb-api` for service logs;
- `/opt/gmweb-api/data/browser-recovery.jsonl` for durable structured events;
- `/var/log/gmweb/monitor.log` for the independent timer watchdog.

When `WEBHOOK_URL` points to Eve or another monitoring server, the same
`browser_recovering` and `browser_hard_restart` events are also posted there.
Without `WEBHOOK_URL`, recovery logs remain only on the GMweb server.

The dashboard Overview card reports `automation_healthy` or `Hung`. The Queue
page reports queued/started timestamps, waiting and active durations, current
browser stage, time in that stage, attempts, SQLite tracking status, and a
plain-language diagnosis. Existing Redis backlog is imported into SQLite on
startup; all new sends, including sends using `Idempotency-Key`, are recorded
there from acceptance onward.

Overview also reports total CPU utilization/core count/load averages and
available/used RAM and swap. Conversation discovery is persisted in
`data/conversation-index.json`: restart uses that index immediately, while the
first run is capped by `CONVERSATION_INDEX_MAX_BATCHES` and
`CONVERSATION_INDEX_BUDGET_MS`. After first-run indexing, GMweb reloads the
conversation page to release the expanded sidebar DOM. Systemd CPU weights
favor `gmweb-api` over Chrome under contention so health and admin controls
remain responsive without throttling Chrome while spare CPU exists.

## Server Manager

On Ubuntu installs, run:

```bash
gmweb
```

The menu includes status, readiness, smoke test, restart, Chrome restart,
temporary VNC/noVNC access, logs, update, token display, dashboard credential
reset, and uninstall.

Non-interactive commands:

```bash
gmweb status
gmweb restart
gmweb restart-chrome
gmweb vnc-on
gmweb vnc-off
gmweb logs api
gmweb token
gmweb smoke
gmweb credentials
gmweb update
```

### Safe server update

The installed manager already has **option 11: Update from git**, equivalent to
`sudo gmweb update`. It runs `git pull --ff-only`, installs the locked production
dependencies with `npm ci --omit=dev`, and restarts only `gmweb-api.service`;
Chrome, its paired profile, Redis, and the durable SQLite send ledger stay in
place.

Older archive-based installations have no `.git` directory. Option 11 detects
that automatically and performs a one-time safe conversion: it clones `main`
into a staging directory, validates dependencies and syntax, pauses and drains
the queue, stops API/Chrome, backs up `.env`, `data/`, and `/var/lib/gmweb`,
atomically swaps the app directory, and waits for readiness. If readiness fails,
the previous directory is restored automatically. Successful conversion prints
both backup paths; future option-11 updates use normal `git pull --ff-only`.

For the safest production rollout:

1. In Dashboard → Queue, pause the queue. The active send is allowed to finish.
2. Wait until the active count is zero; queued messages remain durable.
3. Back up `/opt/gmweb-api/.env` and the `data/` directory.
4. Run `sudo gmweb`, choose option 11, or run `sudo gmweb update` directly.
5. Run `sudo gmweb status` and `sudo gmweb smoke`, then inspect
   `sudo journalctl -u gmweb-api -n 100 --no-pager` if readiness is not green.
6. Resume the queue from the dashboard.

This flow has a short API restart window (normally a few seconds), but does not
lose queued messages or the Google pairing. True zero-HTTP-downtime is not
currently provided: the deployment has one API/worker process controlling one
browser, so running two releases concurrently would risk duplicate browser
workers. Blue/green deployment requires separating the HTTP API from the single
send worker before adding a second API instance.

`gmweb credentials` can keep or change the dashboard username and can either
generate a strong password or accept a password entered twice without echoing
it to the terminal.

## Uninstall

Run:

```bash
gmweb uninstall
```

The uninstaller removes GMweb systemd services, `/usr/local/bin/gmweb*`
commands, `/opt/gmweb-api`, the browser profile, cached session data, and the
`gmweb` service user after you type `DELETE GMWEB`.

Chrome and VNC packages are only removed if you type `REMOVE PACKAGES`, because
they may be shared by other tools on the same VPS.

## Dashboard

Open:

```text
http://127.0.0.1:3030/dashboard
```

The dashboard uses the same `API_TOKEN`. It also sets an HttpOnly dashboard
cookie so the embedded noVNC iframe can access `/vnc`.

Production VPS installs create a limited sudoers file at
`/etc/sudoers.d/gmweb-api` so the `gmweb` service user can only start/stop VNC
and restart GMweb services from the dashboard.

## Public HTTPS Dashboard

Do not expose port `3030` directly to the internet. Keep:

```env
HOST=127.0.0.1
```

Then publish the dashboard through Nginx and Let's Encrypt:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

Useful commands:

```bash
gmweb public-dashboard status
gmweb public-dashboard credentials
gmweb public-dashboard remove dashboard.example.com
```

After install, open:

```text
https://dashboard.example.com/dashboard
```

The public setup sets `DASHBOARD_COOKIE_SECURE=true` and
`CORS_ORIGIN=https://dashboard.example.com`. It also creates a dashboard
username/password login before the API token step.

## Rotate API Token

Generate a token:

```bash
npm run token
```

Put it in `.env`:

```env
API_TOKEN=<new-token>
```

For an atomic rotation from the server manager, use:

```bash
sudo gmweb token-reset
```

The command generates a strong token, restarts the API, verifies that the new
token can access an admin endpoint, and restores the previous token if
activation fails. The same action is available as option 15 in the `gmweb`
interactive menu.

Restart the process.

## Backup Browser Profile

Stop the server first, then back up:

```bash
tar -czf browser-profile-backup.tgz data/browser-profile
```

Restore by extracting it back to `data/browser-profile`.

## Readiness Check

Use:

```text
GET /ready
```

It returns HTTP `200` when paired and HTTP `503` when not ready.

## Speed

For production, keep:

```env
POLL_INTERVAL_MS=0
```

This disables background polling so send requests are not delayed by page reads.
Repeat sends are faster after the first successful send because recipient
conversation hrefs are cached in `data/conversation-cache.json`.

## Local Doctor

Run:

```bash
npm run doctor
```

To also check the running HTTP server:

```bash
DOCTOR_CHECK_SERVER=true npm run doctor
```

## Recovery

If Google Messages gets stuck:

```text
POST /browser/restart
```

If that does not recover, stop the process, run `npm run login`, repair Google Messages manually, close Chrome, and start the server again.

## Security

- Keep `.env` and `data/browser-profile` private.
- Do not enable `ENABLE_DEBUG_ROUTES` on public servers.
- Put the service behind HTTPS and a firewall.
- Prefer `HOST=127.0.0.1` behind Nginx.
