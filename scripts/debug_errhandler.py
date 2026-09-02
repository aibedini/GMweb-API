"""The killer is the uncaught FST_ERR_REP_ALREADY_SENT from /send/status
(Eve polling). Fastify default behavior: an error thrown inside an async
handler AFTER reply.sent → uncaught exception → process exit. Fix: guard
the /send/status handler (and any reply.raw.write users) — but simplest
robust net: setFastRequireErrorHandling? Fastify has
setErrorHandler — add a global error handler that catches
FST_ERR_REP_ALREADY_SENT and just returns (reply already sent)."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r"""
cd /opt/gmweb-api
grep -n "setErrorHandler" src/server.js | head -2
sed -n "$(grep -n 'app.get("/send/status/:reference"' src/server.js | cut -d: -f1),+3p" src/server.js
grep -n "reply.hijack\|hijack()" src/server.js | head -3
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
print(out[:800])
ssh.close()
