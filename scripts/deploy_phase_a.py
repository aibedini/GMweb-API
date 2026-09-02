"""Deploy Phase A (95ed9d9) + full stability + pairing smoke."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
cd /opt/gmweb-api
echo "HEAD before: $(git rev-parse --short HEAD)"
git pull --ff-only origin main 2>&1 | tail -1
echo "HEAD after: $(git rev-parse --short HEAD)"
npm test --silent 2>&1 | grep -E "^. (tests|pass|fail)" | head -3
systemctl restart gmweb-api
sleep 4
systemctl is-active gmweb-api
FAILS=0
for i in $(seq 1 15); do
  CODE=$(timeout 5 curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3030/health || echo 000)
  [ "$CODE" != "200" ] && FAILS=$((FAILS+1))
  sleep 2
done
echo "stability fails: $FAILS"
timeout 10 curl -s -o /dev/null -w "pairing-smoke-local:%{http_code}\n" -X POST http://127.0.0.1:3030/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"smoke-a1","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n-a1"}'
timeout 15 curl -s -o /dev/null -w "pairing-smoke-nginx:%{http_code}\n" -X POST https://gmweb.46.31.76.103.nip.io/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"smoke-a2","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n-a2"}'
systemctl show gmweb-api -p NRestarts
'''

def run(ssh, cmd, timeout=600):
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
    print("[stderr]", err[-400:])
ssh.close()
sys.exit(0 if code == 0 else 1)
