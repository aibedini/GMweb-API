"""Deploy step 4: pm2 not on root's PATH (deployed under eve_deploy's pm2 or
systemd). Detect the service manager and restart accordingly, then verify.
"""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== find the process =="
ps aux | grep -E "node.*server.js" | grep -v grep | head -3
echo "== systemd? =="
systemctl list-units --type=service 2>/dev/null | grep -i gmweb || true
echo "== eve_deploy pm2? =="
ls /home/eve_deploy/.pm2/pids/ 2>/dev/null | head -3 || true
which sudo >/dev/null 2>&1 && sudo -u eve_deploy which pm2 2>/dev/null || true
ls /usr/local/bin/pm2 /usr/bin/pm2 2>/dev/null || true
find / -maxdepth 4 -name "pm2" -type f 2>/dev/null | head -2
'''

def run(ssh, cmd, timeout=300):
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
