// Find failing test files — with a hard per-file timeout and parallel-off.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const files = fs.readdirSync("test").filter((f) => f.endsWith(".test.js"));
for (const f of files) {
  let out = "";
  try {
    out = execFileSync("node", ["--test", "--test-reporter=dot", `test/${f}`], {
      timeout: 30000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const m = out.match(/fail (\d+)/);
    if (m && Number(m[1]) > 0) console.log("FAILING:", f, "failures:", m[1]);
  } catch (e) {
    const out2 = (e.stdout || "") + (e.stderr || "");
    const m = out2.match(/fail (\d+)/);
    if (m && Number(m[1]) > 0) console.log("FAILING:", f, "failures:", m[1]);
    else if (e.killed) console.log("TIMEOUT(30s):", f, "— likely an async leak, checking…");
    else console.log("OTHER:", f, out2.slice(0, 80));
  }
}
console.log("scan done");
