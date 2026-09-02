"""The local POST returned 000 instantly — the server isn't listening on
127.0.0.1:3000 or listens on another port/socket. Check the real port,
env, and what the service actually runs."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== listening ports =="
ss -tlnp | grep -E "node|:3000|:80|:443" | head -8
echo "== service env =="
systemctl show gmweb-api -p Environment -p ExecStart | head -4
echo "== external health works? =="
curl -s -o /dev/null -w "health-via-nginx:%{http_code} in %{time_total}s\n" https://gmweb.46.31.76.103.nip.io/health
echo "== nginx pairing POST (external) =="
timeout 15 curl -s -o /tmp/pair.json -w "%{http_code} in %{time_total}s\n" -X POST https://gmweb.46.31.76.103.nip.io/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"t1","webSigningPublicKey":"PK-sign","webEncryptionPublicKey":"PK-enc","ephemeralPublicKey":"PK-eph","nonce":"n1"}' || echo CURL-FAIL
head -c 300 /tmp/pair.json 2>/dev/null; echo
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
