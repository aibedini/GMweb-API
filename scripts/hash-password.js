const crypto = require("node:crypto");

let password = process.argv[2];
if (process.argv[2] === "--stdin") {
  password = require("node:fs").readFileSync(0, "utf8");
}
if (!password) {
  console.error("Usage: node scripts/hash-password.js <password|--stdin>");
  process.exit(2);
}

const n = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(24).toString("base64url");
const derived = crypto.scryptSync(password, salt, 64, {
  N: n,
  r,
  p,
  maxmem: 64 * 1024 * 1024
}).toString("base64url");

console.log(`scrypt$v1$${n}$${r}$${p}$${salt}$${derived}`);
