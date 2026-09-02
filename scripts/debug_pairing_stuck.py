"""Debug stuck pairing: journalctl tail + direct local curl on the VPS."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== service =="
systemctl is-active gmweb-api
echo "== local direct pairing POST =="
timeout 10 curl -s -o /tmp/pair.json -w "%{http_code} in %{time_total}s\n" -X POST http://127.0.0.1:3000/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"t1","webSigningPublicKey":"PK-sign","webEncryptionPublicKey":"PK-enc","ephemeralPublicKey":"PK-eph","nonce":"n1"}'
head -c 300 /tmp/pair.json; echo
echo "== recent errors =="
journalctl -u gmweb-api -n 20 --no-pager | grep -E "level\":50|Error" | tail -5
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
    print("[stderr]", err[-400:])
ssh.close()
