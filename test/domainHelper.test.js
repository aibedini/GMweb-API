"use strict";
// Behavioural tests for scripts/gmweb-domain-helper.sh against stubbed nginx,
// systemctl, certbot and flock. These prove the helper's own logic (validation,
// rollback, ownership marker, honesty of failures). They do NOT prove behaviour
// of real nginx or a real Let's Encrypt issuance — see spec NOT VERIFIED.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HELPER = path.join(__dirname, "..", "scripts", "gmweb-domain-helper.sh");
const BASH = process.env.GMWEB_TEST_BASH
  || (process.platform === "win32" && fs.existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "command -v timeout install mktemp"]).status === 0;
const fwd = (p) => p.replace(/\\/g, "/");

function sandbox() {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-helper-")));
  const bin = `${root}/stubs`;
  fs.mkdirSync(bin, { recursive: true });
  const stub = (name, body) => {
    fs.writeFileSync(`${bin}/${name}`, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  stub("flock", "exit 0");
  // nginx -t fails while $ROOT/fail-nginx-test exists; every call is logged.
  stub("nginx", `echo "nginx $*" >> "${root}/calls.log"; [ -e "${root}/fail-nginx-test" ] && exit 1; exit 0`);
  stub("systemctl", `echo "systemctl $*" >> "${root}/calls.log"; [ -e "${root}/fail-reload" ] && exit 1; exit 0`);
  // certbot fakes issuance by creating the live files unless told to fail.
  stub("certbot", `echo "certbot $*" >> "${root}/calls.log"
if [ -e "${root}/fail-certbot" ]; then echo "Challenge failed for domain"; exit 1; fi
h=""; while [ $# -gt 0 ]; do [ "$1" = "-d" ] && h="$2"; shift; done
mkdir -p "${root}/etc/letsencrypt/live/$h"; echo cert > "${root}/etc/letsencrypt/live/$h/fullchain.pem"; echo key > "${root}/etc/letsencrypt/live/$h/privkey.pem"`);
  const run = (...args) => {
    const r = spawnSync(BASH, [fwd(HELPER), ...args], {
      encoding: "utf8",
      env: { ...process.env, GMWEB_HELPER_TEST_ROOT: root, GMWEB_HELPER_TEST_STUBS: bin.replace(/^([A-Za-z]):/, "/$1") },
    });
    let json = null;
    try { json = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* leave null */ }
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const site = (h) => `${root}/etc/nginx/sites-available/gmweb-domain-${h}.conf`;
  const link = (h) => `${root}/etc/nginx/sites-enabled/gmweb-domain-${h}.conf`;
  const calls = () => (fs.existsSync(`${root}/calls.log`) ? fs.readFileSync(`${root}/calls.log`, "utf8") : "");
  return { root, run, site, link, calls, flag: (n) => fs.writeFileSync(`${root}/${n}`, "1") };
}

const opts = { skip: !haveBash && "bash with timeout/install/mktemp not available" };

test("apply writes a gated, marked site and reloads nginx", opts, () => {
  const s = sandbox();
  const r = s.run("apply", "sms.example.com", "main-web");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { ok: true, action: "apply", hostname: "sms.example.com" });
  const conf = fs.readFileSync(s.site("sms.example.com"), "utf8");
  assert.match(conf, /managed-by: gmweb-domain-helper/);
  assert.match(conf, /server_name sms\.example\.com;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3030;/);
  assert.ok(fs.existsSync(s.link("sms.example.com")));
  assert.match(s.calls(), /nginx -t[\s\S]*systemctl reload nginx/);
});

test("service surfaces map to fixed locations only", opts, () => {
  const s = sandbox();
  s.run("apply", "api.example.com", "public-api");
  const api = fs.readFileSync(s.site("api.example.com"), "utf8");
  assert.match(api, /location \/api\/ \{/);
  assert.match(api, /location = \/health \{/);
  assert.match(api, /location \/ \{ return 404; \}/);
  s.run("apply", "adm.example.com", "admin");
  const adm = fs.readFileSync(s.site("adm.example.com"), "utf8");
  assert.match(adm, /location \/admin\/ \{/);
  assert.doesNotMatch(adm, /location \/api\//);
});

test("hostile hostnames and services are refused before touching anything", opts, () => {
  const s = sandbox();
  const hosts = ["a b.example.com", "x;rm -rf /.example.com", "../etc/passwd", "evil.com\nserver_name x", "*.example.com",
    "-a.example.com", "a..example.com", "localhost", "1.2.3.4", "EXAMPLE.com", "a.example.com:80", "$(id).example.com", ""];
  for (const host of hosts) {
    const r = s.run("apply", host, "main-web");
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(host)}`);
    assert.equal(r.json?.ok, false);
  }
  for (const svc of ["", "../x", "main-web; id", "unknown", "MAIN-WEB"]) {
    const r = s.run("apply", "ok.example.com", svc);
    assert.equal(r.json?.code, "INVALID_SERVICE", svc);
  }
  assert.equal(s.run("destroy", "ok.example.com").json?.code, "USAGE");
  assert.equal(s.run("apply", "ok.example.com", "main-web", "extra", "more").json?.code, "USAGE");
  assert.ok(!fs.existsSync(`${s.root}/etc/nginx/sites-available`), "nothing was written");
  assert.equal(s.calls(), "");
});

test("a failing nginx -t restores the previous file and does not reload", opts, () => {
  const s = sandbox();
  assert.equal(s.run("apply", "a.example.com", "main-web").status, 0);
  const before = fs.readFileSync(s.site("a.example.com"), "utf8");
  s.flag("fail-nginx-test");
  const r = s.run("apply", "a.example.com", "admin");
  assert.equal(r.json.code, "NGINX_TEST_FAILED");
  assert.equal(fs.readFileSync(s.site("a.example.com"), "utf8"), before);
  // A brand new domain that fails the test leaves no file or link behind.
  const r2 = s.run("apply", "new.example.com", "main-web");
  assert.equal(r2.json.code, "NGINX_TEST_FAILED");
  assert.ok(!fs.existsSync(s.site("new.example.com")));
  assert.ok(!fs.existsSync(s.link("new.example.com")));
  const reloads = s.calls().split("\n").filter((l) => l.includes("reload")).length;
  assert.equal(reloads, 1, "only the initial successful apply reloaded");
});

test("never overwrites or removes a file it did not create", opts, () => {
  const s = sandbox();
  fs.mkdirSync(`${s.root}/etc/nginx/sites-available`, { recursive: true });
  fs.writeFileSync(s.site("mine.example.com"), "server { server_name mine.example.com; }\n");
  assert.equal(s.run("apply", "mine.example.com", "main-web").json.code, "FOREIGN_FILE");
  assert.equal(s.run("remove", "mine.example.com").json.code, "FOREIGN_FILE");
  assert.match(fs.readFileSync(s.site("mine.example.com"), "utf8"), /^server \{/);
});

test("refuses a hostname already served by a foreign nginx site", opts, () => {
  const s = sandbox();
  fs.mkdirSync(`${s.root}/etc/nginx/sites-enabled`, { recursive: true });
  fs.writeFileSync(`${s.root}/etc/nginx/sites-enabled/other.conf`, "server {\n  server_name other.example.com www.other.example.com;\n}\n");
  assert.equal(s.run("apply", "www.other.example.com", "main-web").json.code, "SERVER_NAME_IN_USE");
  assert.equal(s.run("apply", "example.com", "main-web").status, 0, "a suffix of a foreign name is not a match");
});

test("issue requires an applied site", opts, () => {
  const s = sandbox();
  const r = s.run("issue", "sms.example.com");
  assert.equal(r.json.code, "NOT_APPLIED");
  assert.doesNotMatch(s.calls(), /certbot/);
});

test("issue obtains a certificate, then serves HTTPS and redirects HTTP", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  const r = s.run("issue", "sms.example.com", "ops@example.com");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(s.calls(), /certbot certonly --nginx -d sms\.example\.com --cert-name sms\.example\.com .*--email ops@example\.com/);
  assert.match(s.calls(), /--deploy-hook systemctl reload nginx/);
  const conf = fs.readFileSync(s.site("sms.example.com"), "utf8");
  assert.match(conf, /listen 443 ssl http2;/);
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(conf, /ssl_certificate .*sms\.example\.com\/fullchain\.pem;/);
  assert.match(conf, /# service: main-web/);
  // Re-applying keeps TLS (does not silently downgrade to HTTP).
  assert.equal(s.run("apply", "sms.example.com", "main-web").status, 0);
  assert.match(fs.readFileSync(s.site("sms.example.com"), "utf8"), /listen 443 ssl/);
});

test("issue without an e-mail registers explicitly without one; a bad e-mail is refused", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  assert.equal(s.run("issue", "sms.example.com", "not-an-email;id").json.code, "INVALID_EMAIL");
  assert.equal(s.run("issue", "sms.example.com").status, 0);
  assert.match(s.calls(), /--register-unsafely-without-email/);
});

test("a certbot failure is reported and the site stays HTTP-only", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  s.flag("fail-certbot");
  const r = s.run("issue", "sms.example.com");
  assert.equal(r.status, 7);
  assert.equal(r.json.code, "CERTBOT_FAILED");
  assert.match(r.json.message, /Challenge failed/);
  assert.doesNotMatch(fs.readFileSync(s.site("sms.example.com"), "utf8"), /443/);
});

test("a failing nginx test after issuance restores the HTTP-only site", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  const before = fs.readFileSync(s.site("sms.example.com"), "utf8");
  s.flag("fail-nginx-test");
  const r = s.run("issue", "sms.example.com");
  assert.equal(r.json.code, "NGINX_TEST_FAILED");
  assert.equal(fs.readFileSync(s.site("sms.example.com"), "utf8"), before);
});

test("remove deletes only the managed site, keeps the certificate, and is idempotent", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  s.run("issue", "sms.example.com");
  assert.equal(s.run("remove", "sms.example.com").status, 0);
  assert.ok(!fs.existsSync(s.site("sms.example.com")));
  assert.ok(!fs.existsSync(s.link("sms.example.com")));
  assert.ok(fs.existsSync(`${s.root}/etc/letsencrypt/live/sms.example.com/fullchain.pem`), "certificate retained");
  assert.equal(s.run("remove", "sms.example.com").status, 0);
});

test("output is a single sanitised JSON line", opts, () => {
  const s = sandbox();
  s.run("apply", "sms.example.com", "main-web");
  s.flag("fail-certbot");
  const r = s.run("issue", "sms.example.com");
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.ok(r.json.message.length <= 400);
  assert.doesNotMatch(r.stdout, /\/etc\/|privkey/);
});

test("helper is not world-writable in source form and pins the upstream", () => {
  const src = fs.readFileSync(HELPER, "utf8");
  assert.match(src, /readonly UPSTREAM="127\.0\.0\.1:3030"/);
  assert.doesNotMatch(src, /\beval\b/);
});

test("helper service allowlist matches the API registry", () => {
  const { serviceIds, getService } = require("../src/domainStore");
  const src = fs.readFileSync(HELPER, "utf8");
  const arms = [...src.matchAll(/^\s{4}([a-z-]+)\)\n/gm)].map((m) => m[1]);
  assert.deepEqual(arms.sort(), serviceIds().sort());
  for (const id of serviceIds()) assert.ok(getService(id));
});
