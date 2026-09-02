"""Flapping upstream: time single direct request + node CPU/state."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r"""
PID=$(pgrep -f 'node src/server.js' | head -1)
echo "pid=$PID"
ps -o pid,pcpu,pmem,stat,etime -p $PID
echo "== 5 timed single requests =="
for i in 1 2 3 4 5; do
  timeout 5 curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" http://127.0.0.1:3030/health
  sleep 1
done
echo "== eve hammering? =="
ss -tn state established '( sport = :3030 )' | wc -l
"""

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
