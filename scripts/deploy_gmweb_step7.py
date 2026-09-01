"""Deploy step 7: pull migration fix (8574afa), restart, verify end-to-end."""
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
systemctl restart gmweb-api
sleep 5
systemctl is-active gmweb-api && echo SERVICE-ACTIVE
curl -s http://127.0.0.1:3000/health; echo
echo "== /web + pairing surface (timing matters) =="
curl -s -o /dev/null -w "web:%{http_code}\n" http://127.0.0.1:3000/web
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
curl -s -o /dev/null -w "session-id-anon(expect 401):%{http_code}\n" "http://127.0.0.1:3000/api/v1/pairing/session/deploy-check"
curl -s -o /dev/null -w "approve-anon(expect 401):%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/approve \
  -H 'Content-Type: application/json' -d '{"pairingSessionId":"x","certificate":"c","deviceId":"d","transcriptHash":"t","trustRootPublicKey":"k"}'
'''

def run(ssh, cmd, timeout=300):
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
