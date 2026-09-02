"""The request ARRIVES at fastify but never completes → my stream-level
rawBody fallback hook (added for the parser collision) never calls done()
when the body was already consumed by the winning JSON parser. Fix: only
attach the stream readers when body parsing will NOT run (no content-type
or the rawBody absent), and always call done exactly once."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
set -e
cd /opt/gmweb-api
echo "== confirm the hook is the blocker: hit a GET route =="
timeout 6 curl -s -o /dev/null -w "health:%{http_code} in %{time_total}s\n" http://127.0.0.1:3030/health || echo GET-ALSO-HANGS
echo "== journal last request =="
journalctl -u gmweb-api -n 8 --no-pager | tail -8
'''

def run(ssh, cmd, timeout=60):
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
