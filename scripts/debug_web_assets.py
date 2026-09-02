"""Bad Gateway on /web assets — the PWA HTML loads (200) but its hashed JS/CSS
chunk requests are 502ing (stale nginx cache or asset upload gap). Check which
asset the served HTML references vs what exists on disk."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
echo "== HTML references =="
grep -oE 'assets/index-[^"]+' /opt/gmweb-api/public/web-app/index.html
echo "== files on disk =="
ls /opt/gmweb-api/public/web-app/assets/
echo "== nginx error tail =="
tail -4 /var/log/nginx/error.log | grep -E "502|upstream" | tail -3
echo "== direct asset fetch (bypass nginx) =="
JS=$(grep -oE '/web/assets/index-[^"]+\.js' /opt/gmweb-api/public/web-app/index.html | head -1)
timeout 5 curl -s -o /dev/null -w "direct-js:%{http_code}\n" "http://127.0.0.1:3030$JS"
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
    print("[stderr]", err[-300:])
ssh.close()
