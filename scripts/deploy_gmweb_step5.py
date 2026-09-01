"""Deploy step 5: gmweb-api runs under SYSTEMD (user gmweb) — restart via
systemctl, then full verification (health, version, /web, pairing surface,
external)."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
echo "== restart systemd service =="
systemctl restart gmweb-api
sleep 4
systemctl is-active gmweb-api
echo "== health =="
curl -s http://127.0.0.1:3000/health; echo
echo "== version =="
cd /opt/gmweb-api && node -e "console.log('version:', require('./package.json').version)"
echo "== /web served =="
curl -s -o /dev/null -w "web:%{http_code}\n" http://127.0.0.1:3000/web
echo "== pairing surface =="
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
curl -s -o /dev/null -w "session-id-anon(expect 401):%{http_code}\n" "http://127.0.0.1:3000/api/v1/pairing/session/deploy-check"
echo "== service log tail =="
journalctl -u gmweb-api -n 5 --no-pager 2>/dev/null | tail -5
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
    print("[stderr]", err[-600:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
