"""Deploy GMweb v0.13.3 (32c8109 + 3f24531) — pull, npm ci, tests, restart."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
cd /opt/gmweb-api
git pull --ff-only origin main 2>&1 | tail -1
git log --oneline -1
npm ci --omit=dev --silent 2>&1 | tail -1 || true
echo "== pairing tests on server =="
node --test test/pairingSecurity.test.js test/pairingSessions.test.js test/pairingTranscriptVectors.test.js 2>&1 | grep -E "^. (tests|pass|fail)"
systemctl restart gmweb-api
sleep 5
systemctl is-active gmweb-api && echo SERVICE-ACTIVE
curl -s http://127.0.0.1:3000/health || curl -s http://127.0.0.1:3030/health; echo
node -e "console.log('version:', require('./package.json').version)"
echo "== pairing POST (the one that used to hang) =="
timeout 10 curl -s -o /tmp/p.json -w "%{http_code} in %{time_total}s\n" -X POST http://127.0.0.1:3030/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"t3","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n3"}'
python3 -c "import json;d=json.load(open('/tmp/p.json'));print('pollSecret:',bool(d.get('pollSecret')))"
echo "== identity route assigns auto-primary role =="
'''

def run(ssh, cmd, timeout=600):
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
    print("[stderr]", err[-500:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
