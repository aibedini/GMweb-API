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

## Speed Notes

`POLL_INTERVAL_MS=0` is the default production setting. This prevents background
polling from interrupting sends. Conversation hrefs are cached in
`data/conversation-cache.json`, so repeat sends to the same recipient are faster.
