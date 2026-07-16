# Simple Setup

Fresh install or repair/reinstall on Ubuntu 22:

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/aibedini/GMweb-API/main/install/ubuntu22.sh | sudo bash
```

Running the same command again repairs the installation, updates `/opt/gmweb-api`,
rebuilds the React app, rotates the API token and dashboard password, and
restarts the services.

The installer prepares:

- Chrome on a virtual display
- GMweb API service
- API and both web interfaces on public port `3030`
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

```bash
curl -H "Authorization: Bearer TOKEN" http://SERVER_IP:3030/ready
```

## 5. Use The Dashboard

Open `http://SERVER_IP:3030/app` for the React console or
`http://SERVER_IP:3030/dashboard` for the classic dashboard.

Enter the API token. The dashboard includes status, send, conversations,
restart controls, VNC on/off, and an embedded noVNC console.

## 6. Make The Dashboard Public

Point a domain to the VPS, then run:

```bash
gmweb public-dashboard install dashboard.example.com admin@example.com
```

After that, open:

```text
https://dashboard.example.com/dashboard
```

For production HTTPS, use the optional public-dashboard command above. Ensure
TCP port `3030` is allowed by the VPS provider firewall when using direct access.

## Speed Notes

`POLL_INTERVAL_MS=0` is the default production setting. This prevents background
polling from interrupting sends. Conversation hrefs are cached in
`data/conversation-cache.json`, so repeat sends to the same recipient are faster.
