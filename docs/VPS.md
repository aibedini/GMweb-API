# GMweb API VPS Setup

For a fresh Ubuntu 22 server, prefer the automated installer and manager menu:

```bash
curl -fsSL https://raw.githubusercontent.com/aibedini/GMweb-API/main/install/ubuntu22.sh | sudo bash
gmweb
```

The `gmweb` menu manages status, restart, logs, temporary VNC pairing access,
token display, smoke tests, updates, and uninstall.

## 1. Install

```bash
git clone <your-repo-url> gmweb-api
cd gmweb-api
npm install
cp .env.example .env
```

Install Chrome if it is not already installed.

## 2. Configure .env

```env
NODE_ENV=production
PORT=3030
HOST=0.0.0.0
API_TOKEN=use-a-long-random-token
HEADLESS=true
USER_DATA_DIR=./data/browser-profile
```

The quick installer uses `HOST=0.0.0.0`, so `/app`, `/dashboard`, and the token-protected API are reachable at `http://SERVER_IP:3030`.

## 3. Pair Google Messages

Start once:

```bash
npm start
```

Open:

```text
GET /session/screenshot
```

Scan the QR with Google Messages on your phone. The session is stored in `data/browser-profile`.

## 4. Run with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Notes

- Keep `data/browser-profile` private and backed up. It contains the paired browser state.
- Do not expose this API publicly without HTTPS, firewall rules, and a strong `API_TOKEN`.
- `ENABLE_DEBUG_ROUTES=false` should stay false in production.
- For a VPS without a real GUI, use [VPS_NO_GUI.md](VPS_NO_GUI.md).
