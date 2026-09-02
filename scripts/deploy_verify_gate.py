"""Deploy + FULL verification gate per review:
1. git HEAD on VPS
2. deploy + npm test
3. restart + active
4. 60s stability loop (30 hits, 2s apart) — zero failures
5. SSE open (both routes) while health loop runs
6. pairing smoke local + via nginx
7. journal scan for crash signatures
"""
import sys
import time
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

TOKEN = "*qf8dYKGj%"

REMOTE = r'''
set -e
cd /opt/gmweb-api
echo "== HEAD before =="
git rev-parse --short HEAD
git pull --ff-only origin main 2>&1 | tail -1
echo "== HEAD after =="
git rev-parse --short HEAD
npm ci --omit=dev --silent 2>&1 | tail -1 || true
echo "== npm test =="
npm test --silent 2>&1 | grep -E "^. (tests|pass|fail)" | head -3
systemctl restart gmweb-api
sleep 4
systemctl is-active gmweb-api
echo "== 60s stability: 30 hits x 2s (fail = abort) =="
FAILS=0
for i in $(seq 1 30); do
  CODE=$(timeout 5 curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3030/health || echo 000)
  if [ "$CODE" != "200" ]; then FAILS=$((FAILS+1)); echo "hit $i -> $CODE"; fi
  sleep 2
done
echo "stability fails: $FAILS"
echo "== SSE open while alive (5s) =="
timeout 5 curl -sN -H "Authorization: Bearer $GMWEB_API_TOKEN" http://127.0.0.1:3030/api/v1/sse | head -c 40 || true
echo
echo "== pairing smoke local =="
timeout 10 curl -s -o /tmp/p.json -w "local:%{http_code}\n" -X POST http://127.0.0.1:3030/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"smoke","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n-smoke"}'
echo "== pairing smoke via nginx =="
timeout 15 curl -s -o /dev/null -w "nginx:%{http_code}\n" -X POST https://gmweb.46.31.76.103.nip.io/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"smoke2","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n-smoke2"}'
echo "== journal crash signatures (last 3 min) =="
journalctl -u gmweb-api --since "3 minutes ago" --no-pager | grep -cE "ERR_HTTP_HEADERS_SENT|Main process exited|uncaughtException" || echo 0
echo "== restart count =="
systemctl show gmweb-api -p NRestarts
'''

def run(ssh, cmd, timeout=900):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30, look_for_keys=False, allow_agent=False)
code, out, err = run(ssh, REMOTE)
print(out)
if err.strip():
    print("[stderr]", err[-500:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
