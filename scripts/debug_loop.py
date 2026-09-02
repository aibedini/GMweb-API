"""Confirm restart loop + capture the crash."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r"""
systemctl status gmweb-api --no-pager | grep -E "Active|restart|Main PID" | head -4
journalctl -u gmweb-api -n 40 --no-pager | grep -B2 -A8 -E "Main process exited|FAILURE|Error" | head -30
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
print(out[:2000])
if err.strip():
    print("[stderr]", err[-300:])
ssh.close()
