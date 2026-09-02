"""Final deploy: pull raw-body fix (76f9fb2+), restart, verify."""
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
node --test test/pairingE2EComposition.test.js 2>&1 | grep -E "^. (tests|pass|fail)"
systemctl restart gmweb-api
sleep 4
systemctl is-active gmweb-api
curl -s http://127.0.0.1:3030/health; echo
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
    print("[stderr]", err[-400:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
