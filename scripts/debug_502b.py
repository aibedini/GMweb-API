"""502 root: is the app listening? Which port? Test both direct ports."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r"""
ss -tlnp | grep node | head -3
for PORT in 3000 3030 8080; do
  timeout 5 curl -s -o /dev/null -w "port-$PORT:%{http_code}\n" http://127.0.0.1:$PORT/health 2>/dev/null || echo "port-$PORT: down"
done
grep -E "PORT|port" /opt/gmweb-api/.env 2>/dev/null | head -3
grep -E "PORT" /etc/systemd/system/gmweb-api.service | head -3
"""

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
