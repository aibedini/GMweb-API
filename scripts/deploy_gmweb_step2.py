"""Deploy step 2: on the server the working tree has untracked web-app files
(an older deploy put the built PWA there). Recover: drop our stash (it was
created empty→aborted the pull), keep untracked files, then pull with
checkout of tracked files only, install, test, restart, verify.
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
echo "== reset stash mess =="
git stash pop -q 2>/dev/null || git checkout -- . 2>/dev/null || true
git stash drop -q 2>/dev/null || true
echo "== pull (ff-only) =="
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
echo "== health =="
curl -s http://127.0.0.1:3000/health; echo
echo "== version =="
node -e "console.log('version:', require('./package.json').version)"
echo "== pairing surface =="
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
curl -s -o /dev/null -w "session-id-anon(expect 401):%{http_code}\n" "http://127.0.0.1:3000/api/v1/pairing/session/deploy-check"
'''

def run(ssh, cmd, timeout=900):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err

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
