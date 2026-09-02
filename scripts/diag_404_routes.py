"""Which routes are 404ing? Show req url + status pairs."""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
journalctl -u gmweb-api --since '-15 minutes' --no-pager | grep -oE '"url":"[^"]*","host[^}]*"remoteAddress[^}]*' | grep -oE '"url":"[^"]*"' | sort | uniq -c | sort -rn | head -12
echo "== status codes per route =="
journalctl -u gmweb-api --since '-15 minutes' --no-pager | python3 -c "
import sys, json, re
pairs = {}
for line in sys.stdin:
    m = re.search(r'\"reqId\":\"(req-[^\"]+)\".*?\"url\":\"([^\"]+)\"', line)
    if m: pairs.setdefault(m.group(1), {})['url'] = m.group(2)
    m2 = re.search(r'\"reqId\":\"(req-[^\"]+)\".*?\"statusCode\":(\d+)', line)
    if m2: pairs.setdefault(m2.group(1), {})['status'] = m2.group(2)
from collections import Counter
c = Counter((v.get('url','?').split('?')[0], v.get('status','?')) for v in pairs.values())
for (url, status), n in c.most_common(12):
    print(n, status, url)
"
'''

def run(ssh, cmd, timeout=120):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode("utf-8", "replace")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30, look_for_keys=False, allow_agent=False)
print(run(ssh, REMOTE))
ssh.close()
