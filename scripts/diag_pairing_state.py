"""BLOCKER A diagnostics: is VPS HEAD >= 944429a? What does /pairing/status
say? Is there a pending pairing session?"""
import sys
import paramiko

HOST = "46.31.76.103"
USER = "root"

with open(r"C:\Users\Mahna\AppData\Local\Temp\gmweb_ssh_pw.txt", "r", encoding="utf-8") as f:
    PASSWORD = f.read().strip()

REMOTE = r'''
cd /opt/gmweb-api
echo "HEAD: $(git rev-parse --short HEAD)"
TOKEN=$(grep -E '^API_TOKEN=' .env | cut -d= -f2)
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/control-plane.db', { readonly: true });
try { console.log('identities:', JSON.stringify(db.prepare('SELECT device_id, device_role FROM agent_identities').all())); } catch(e){ console.log('ids:', e.message.slice(0,60)); }
db.close();
"
echo "== server-side pairing log (last 10 min) =="
journalctl -u gmweb-api --since '-10 minutes' --no-pager | grep -oE 'POST /api/v1/pairing/approve[^\"]*|GET /api/v1/pairing/session[^\"]*' | tail -4
'''

def run(ssh, cmd, timeout=120):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, stderr.read().decode("utf-8", "replace")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30, look_for_keys=False, allow_agent=False)
code, out, err = run(ssh, REMOTE)
print(out)
ssh.close()
sys.exit(0 if code == 0 else 1)
