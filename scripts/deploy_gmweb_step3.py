"""Deploy step 3: server has a locally-modified package-lock + untracked
web-app build artifacts (from the pre-ADR-007 hand deploy). The repo now
OWNS those files, so: discard the lock edit, remove the stale untracked
web-app (repo's committed build replaces it), pull, install, test, restart.
"""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
cd /opt/gmweb-api
TS=$(date +%s)
echo "== backup local web-app (just in case) =="
mkdir -p deploy-backups/webapp-$TS
cp -r public/web-app deploy-backups/webapp-$TS/ 2>/dev/null || true
echo "== discard local lock edit; remove stale untracked web-app =="
git checkout -- web/package-lock.json
rm -rf public/web-app
echo "== pull =="
git pull --ff-only origin main 2>&1 | tail -2
git log --oneline -1
echo "== npm ci =="
npm ci --omit=dev --silent 2>&1 | tail -1 || npm install --omit=dev --silent 2>&1 | tail -1
echo "== PUBLIC_WEB_ORIGIN =="
ORIGIN=https://gmweb.46.31.76.103.nip.io
grep -q '^PUBLIC_WEB_ORIGIN=' .env 2>/dev/null && \
  sed -i "s|^PUBLIC_WEB_ORIGIN=.*|PUBLIC_WEB_ORIGIN=$ORIGIN|" .env || \
  echo "PUBLIC_WEB_ORIGIN=$ORIGIN" >> .env
grep '^PUBLIC_WEB_ORIGIN=' .env
echo "== pairing tests =="
node --test test/pairingSecurity.test.js test/pairingSessions.test.js test/pairingTranscriptVectors.test.js 2>&1 | grep -E "^. (tests|pass|fail)"
echo "== restart =="
pm2 restart gmweb-api --update-env 2>&1 | tail -2
sleep 4
echo "== health/version/surface =="
curl -s http://127.0.0.1:3000/health; echo
curl -s -o /dev/null -w "web:%{http_code}\n" http://127.0.0.1:3000/web
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
curl -s -o /dev/null -w "session-id-anon(expect 401):%{http_code}\n" "http://127.0.0.1:3000/api/v1/pairing/session/deploy-check"
'''

def run(ssh, cmd, timeout=900):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30, look_for_keys=False, allow_agent=False)
code, out, err = run(ssh, REMOTE)
print(out)
if err.strip():
    print("[stderr]", err[-800:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
