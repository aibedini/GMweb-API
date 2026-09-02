"""nginx 111 connect failures are intermittent — upstream connection pool
exhaustion or listen backlog. Check nginx worker_connections / keepalive to
node, and whether the node server is dropping connections (uvicorn-style
backlog). Quick test: hammer 20 sequential requests."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== 20 rapid direct hits =="
for i in $(seq 1 20); do
  timeout 3 curl -s -o /dev/null -w "%{http_code} " http://127.0.0.1:3030/health
done; echo
echo "== 20 via nginx =="
for i in $(seq 1 20); do
  timeout 5 curl -s -o /dev/null -w "%{http_code} " https://gmweb.46.31.76.103.nip.io/health
done; echo
echo "== socket stats =="
ss -s | head -5
'''

def run(ssh, cmd, timeout=180):
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
