"use strict";
// Regression guard (Issue 1): every cookie-authenticated PWA fetch MUST send
// the HttpOnly linked/dashboard session cookie via credentials: "include".
// Fixed originally in commit 35247eb; this test keeps it fixed.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "web", "src");

// Files whose fetch call-sites must ALL carry credentials, except the listed
// number of deliberately public (anonymous) calls.
const TARGETS = {
  "lib/api.ts": { anonymousAllowed: 1 }, // health() is public
  "lib/auth.ts": { anonymousAllowed: 0 },
  "lib/security.ts": { anonymousAllowed: 0 },
  "lib/push.ts": { anonymousAllowed: 0 },
  "lib/pairingApi.ts": { anonymousAllowed: 0 },
  "lib/pairing.ts": { anonymousAllowed: 0 },
  "lib/sync.ts": { anonymousAllowed: 0 },
  "lib/adminAccess.ts": { anonymousAllowed: 0 },
  "app/App.tsx": { anonymousAllowed: 0 },
};

describe("PWA sends the HttpOnly session cookie on every authenticated fetch", () => {
  for (const [file, { anonymousAllowed }] of Object.entries(TARGETS)) {
    test(`${file}: credentials: "include" on every authenticated fetch call`, () => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      const fetchCalls = (source.match(/fetch\(/g) || []).length;
      const credentialed = (source.match(/credentials:\s*"include"/g) || []).length;
      assert.ok(
        credentialed >= fetchCalls - anonymousAllowed,
        `${file}: ${fetchCalls} fetch calls but only ${credentialed} carry credentials: "include"`,
      );
    });
  }

  test('lib/api.ts auth endpoints explicitly carry credentials: "include"', () => {
    const source = fs.readFileSync(path.join(root, "lib", "api.ts"), "utf8");
    // Every cookie-authenticated function must fetch WITH credentials. Only
    // health() (anonymous) is exempt.
    for (const fn of ["fetchEventsAfter", "fetchCommand", "fetchTrustSnapshot"]) {
      const start = source.indexOf(`export async function ${fn}(`);
      const end = source.indexOf("\n}", start);
      const body = source.slice(start, end >= 0 ? end : source.length);
      assert.match(body, /fetch\(/, `${fn} must call fetch`);
      assert.match(body, /credentials:\s*"include"/, `${fn} must send the session cookie`);
    }
  });
});
