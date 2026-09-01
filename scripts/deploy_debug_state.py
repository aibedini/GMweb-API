"""Retry deploy: inspect git state on server, then finish remaining steps."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

CHECK = r'''
set -e
cd /opt/gmweb-api
echo "== git state =="
git status --short | head -5
git log --oneline -2
echo "== stash pop? =="
git stash list | head -3
'''

def run(ssh, cmd, timeout=600):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30, look_for_keys=False, allow_agent=False)
code, out, err = run(ssh, CHECK)
print(out)
if err.strip():
    print("[stderr]", err[-600:])
print("exit:", code)
ssh.close()
sys.exit(0 if code == 0 else 1)
