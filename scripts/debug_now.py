"""Real-time 502 forensics: is the service crash-looping RIGHT NOW?
Capture: service state, restart count, latest 3 crash stacks (full lines)."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== state =="
systemctl is-active gmweb-api
systemctl show gmweb-api -p NRestarts -p ExecMainStartTimestamp
echo "== crash line (full) =="
journalctl -u gmweb-api --since "10 minutes ago" --no-pager | grep -E "Main process exited" | tail -2
echo "== last 30 stderr lines before exit =="
journalctl -u gmweb-api --since "10 minutes ago" --no-pager -o cat | grep -vE '"level":30' | tail -20
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
print(out[:2500])
if err.strip():
    print("[stderr]", err[-300:])
ssh.close()