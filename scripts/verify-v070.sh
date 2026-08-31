#!/bin/bash
# Remote verification of GMweb v0.7.0 control-plane endpoints (run ON the VPS)
set -u
cd /opt/gmweb-api
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
BASE=http://127.0.0.1:3030
echo "--- /health (no auth) ---"
curl -s $BASE/health
echo
echo "--- /web ---"
curl -s -o /dev/null -w "%{http_code}\n" $BASE/web
echo "--- /web CSP header ---"
curl -s -D - -o /dev/null $BASE/web | grep -i "content-security" | cut -c1-100
echo "--- /api/v1/push/public-key (auth) ---"
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/push/public-key | head -c 130
echo
echo "--- /api/v1/sse (auth, 3s sample) ---"
curl -s -o /dev/null -w "%{http_code}\n" --max-time 3 -H "Authorization: Bearer $TOKEN" $BASE/api/v1/sse || true
echo "--- /api/v1/sync (auth) ---"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/sync?after=0" | head -c 100
echo
echo "--- /api/v1/commands (auth) ---"
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/commands | head -c 100
echo
echo "--- /api/v1/trust/snapshot (auth) ---"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/trust/snapshot
echo "DONE"
