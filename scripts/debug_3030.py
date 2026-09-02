"""Server listens on 127.0.0.1:3030 (not 3000). Retest pairing POST on 3030
locally + through nginx. The external health worked, so nginx->3030 is fine;
the pairing POST hang must be app-level (rawBody capture hook?)."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== local pairing POST on 3030 =="
timeout 10 curl -s -o /tmp/pair.json -w "%{http_code} in %{time_total}s\n" -X POST http://127.0.0.1:3030/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"t1","webSigningPublicKey":"PK-sign","webEncryptionPublicKey":"PK-enc","ephemeralPublicKey":"PK-eph","nonce":"n1"}' || echo TIMEOUT-LOCAL
head -c 400 /tmp/pair.json 2>/dev/null; echo
echo "== nginx logs tail =="
tail -5 /var/log/nginx/error.log 2>/dev/null || true
echo "== app errors =="
journalctl -u gmweb-api -n 15 --no-pager | grep -E "level\":50|pairing" | tail -5
'''

def run(ssh, cmd, timeout=90):
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
