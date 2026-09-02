"""Final verification: pairing surface + passkey-first GONE from live web."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
echo "== live web bundle: passkey-first copy must be GONE =="
JS=$(ls /opt/gmweb-api/public/web-app/assets/index-*.js | head -1)
grep -c "Create a passkey" "$JS" || echo "0 (passkey gate removed)"
grep -c "Link to your Android" "$JS" || echo "0 (QR screen present?)"
echo "== pairing endpoints through nginx =="
curl -s -o /dev/null -w "session-POST:%{http_code}\n" -X POST https://gmweb.46.31.76.103.nip.io/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"deploy-check","webSigningPublicKey":"x","webEncryptionPublicKey":"y","ephemeralPublicKey":"z","nonce":"n"}'
'''

def run(ssh, cmd, timeout=120):
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
    print("[stderr]", err[-300:])
ssh.close()
