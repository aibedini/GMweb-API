"""Verify pairing POST now completes (with pollSecret) after the hang fix."""
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
  -d '{"webDeviceId":"t1","webSigningPublicKey":"PK-sign","webEncryptionPublicKey":"PK-enc","ephemeralPublicKey":"PK-eph","nonce":"n1"}'
python3 -c "import json;d=json.load(open('/tmp/pair.json'));print('pollSecret:',bool(d.get('pollSecret')),'| origin:',d.get('qr',{}).get('origin'),'| session:',d.get('pairingSessionId','')[:12])"
echo "== Android-only endpoint anonymous (expect 401, fast) =="
timeout 10 curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" "http://127.0.0.1:3030/api/v1/pairing/session/t1"
echo "== via nginx (external) =="
timeout 15 curl -s -o /tmp/pair2.json -w "%{http_code} in %{time_total}s\n" -X POST https://gmweb.46.31.76.103.nip.io/api/v1/pairing/session \
  -H 'Content-Type: application/json' \
  -d '{"webDeviceId":"t2","webSigningPublicKey":"PK-sign","webEncryptionPublicKey":"PK-enc","ephemeralPublicKey":"PK-eph","nonce":"n2"}'
head -c 200 /tmp/pair2.json; echo
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
    print("[stderr]", err[-400:])
ssh.close()
