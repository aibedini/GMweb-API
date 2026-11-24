# Simple Setup

Fresh install or repair/reinstall on Ubuntu 22:

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/aibedini/GMweb-API/main/install/ubuntu22.sh | sudo bash
```

Running the same command again repairs the installation, updates `/opt/gmweb-api`,
rebuilds the React app, rotates the API token and dashboard password, and
restarts the services. It also creates `gmweb.<SERVER_IP>.nip.io`, configures
Nginx, and requests a Let's Encrypt certificate automatically.

Before installation, allow inbound TCP **80** and **443** in the VPS provider
firewall. To supply a custom domain:

```bash
curl -fsSL https://raw.githubusercontent.com/aibedini/GMweb-API/main/install/ubuntu22.sh | \
  sudo env PUBLIC_DOMAIN=gmweb.example.com LETSENCRYPT_EMAIL=admin@example.com bash
```

The installer prepares:

- Chrome on a virtual display
- GMweb API service
- HTTPS reverse proxy with an automatic `nip.io` address
- API and both web interfaces behind that HTTPS address
- local-only noVNC helper for pairing
- a strong API token in `/opt/gmweb-api/.env`

## 2. Pair Google Messages

On the VPS:

```bash
gmweb vnc-on
```

On your own computer:

```bash
ssh -L 6080:127.0.0.1:6080 root@SERVER_IP
```

Open:

```text
http://127.0.0.1:6080/vnc.html
```

Sign in to Google Messages and scan the QR with your phone.

After pairing:

```bash
gmweb vnc-off
```

## 3. Test

On the VPS:

```bash
gmweb status
gmweb smoke
gmweb token
```

You can also type `gmweb` to open the full server menu.

## 4. Open From Your Computer

Use the HTTPS address printed by the installer:

```bash
curl -H "Authorization: Bearer TOKEN" https://gmweb.SERVER_IP.nip.io/ready
```

## 5. Use The Dashboard

Open `https://gmweb.SERVER_IP.nip.io/app` for the React console or
`https://gmweb.SERVER_IP.nip.io/dashboard` for the classic dashboard.

Enter the API token. The dashboard includes status, send, conversations,
restart controls, VNC on/off, and an embedded noVNC console.

## 6. Custom Domain Or Manual HTTPS Repair

Point a domain to the VPS, then run:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

After that, open:

```text
https://dashboard.example.com/dashboard
```

The normal installer already configures HTTPS automatically. Run this command
only to replace the automatic `nip.io` address or repair HTTPS.

## 7. Install Stops At "Daemons using outdated libraries"

A screen like this is **not** the installer asking a question:

```text
┌ Daemons using outdated libraries ─┐
│ Which services should be restarted? │
│ [ ] packagekit.service              │
│ [ ] unattended-upgrades.service     │
│        <Ok>          <Cancel>       │
└─────────────────────────────────────┘
```

It is `needrestart`, which Ubuntu runs as an `apt` hook after library upgrades.
It takes over the terminal, and on a headless VPS — or when the installer is piped
into `bash` — it cannot be answered: Enter and the arrow keys do nothing (they may
appear as literal `^[[A^[[B`), and the install waits there forever.

Current installers never reach this screen: every `apt` call runs with
`DEBIAN_FRONTEND=noninteractive`, `NEEDRESTART_MODE=l` (list only — never prompt,
never restart a daemon behind your back), bounded dpkg lock waits and
`--force-confold`. On start they also repair the half-configured dpkg state that a
previously interrupted run leaves behind, so re-running the install is safe.

If a machine is stuck right now, open a second SSH session and run:

```bash
sudo pkill -f needrestart; sudo pkill -f whiptail
sudo dpkg --configure -a
sudo apt-get -f install -y
```

Then re-run the install (option 1 of `sudo gmweb-install`, or the `curl` command
above). To keep the dialog away from every future manual `apt` run on that box:

```bash
echo "\$nrconf{restart} = 'l';" | sudo tee /etc/needrestart/conf.d/99-list-only.conf
```

Reboot once the install has finished so upgraded libraries reach the running
daemons (`needrestart` only lists them in this mode).

## Speed Notes

`POLL_INTERVAL_MS=0` is the default production setting. This prevents background
polling from interrupting sends. Conversation hrefs are cached in
`data/conversation-cache.json`, so repeat sends to the same recipient are faster.
