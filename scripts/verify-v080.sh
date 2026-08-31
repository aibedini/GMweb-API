#!/bin/bash
# Verify passkey endpoints on the VPS (v0.8.0)
set -u
cd /opt/gmweb-api
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
BASE=http://127.0.0.1:3030
echo "--- auth/status (auth) ---"
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/auth/status
echo
echo "--- register/options (auth) ---"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" $BASE/api/v1/auth/passkey/register/options
echo "--- auth/options (public) ---"
curl -s $BASE/api/v1/auth/passkey/auth/options | head -c 180
echo
echo "--- auth/status anonymous (should be 200 - public) ---"
curl -s $BASE/api/v1/auth/status
echo
echo "--- health version ---"
curl -s $BASE/health
echo
echo DONE
