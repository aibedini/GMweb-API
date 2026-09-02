"""89 crash-signature lines in journal are from BEFORE the deploy (last 3 min
window includes pre-restart crashes). Verify ZERO new signatures AFTER the
restart moment + confirm HEAD = aae2a89 and SSE open works."""
import sys
import time
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
cd /opt/gmweb-api
echo "HEAD: $(git rev-parse --short HEAD)"
SINCE=$(date -d "-90 seconds" "+%H:%M:%S")
echo "== crash signatures since $SINCE (expect 0) =="
journalctl -u gmweb-api --since "$SINCE" --no-pager | grep -cE "ERR_HTTP_HEADERS_SENT|Main process exited|uncaughtException|FST_ERR_REP_ALREADY_SENT" || echo 0
echo "== SSE + health concurrent 30s =="
(timeout 30 curl -sN -H "Authorization: Bearer $GMWEB_API_TOKEN" http://127.0.0.1:3030/api/v1/sse > /tmp/sse.out 2>&1 &) 
FAILS=0
for i in $(seq 1 15); do
  CODE=$(timeout 5 curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3030/health || echo 000)
  [ "$CODE" != "200" ] && FAILS=$((FAILS+1))
  sleep 2
done
echo "health fails with SSE open: $FAILS"
echo "sse output head: $(head -c 20 /tmp/sse.out)"
systemctl show gmweb-api -p NRestarts
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
    print("[stderr]", err[-300:])
ssh.close()
sys.exit(0 if code == 0 else 1)
