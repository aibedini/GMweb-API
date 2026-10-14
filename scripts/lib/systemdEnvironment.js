"use strict";

/**
 * systemd environment mechanics for the GMweb API service.
 *
 * The production incident this supports: `gmweb-api.service` declared only
 * `Environment= NODE_ENV=production` and had NO `EnvironmentFile`, so every other setting
 * depended on `dotenv.config()` finding `.env` relative to the process working directory.
 * A variable present in `.env` was therefore not guaranteed to reach the Node process, and
 * ADR-007's fail-closed origin check killed the service in a restart loop.
 *
 * Everything here is filesystem-injectable (`root`), so the behaviour is tested against
 * temporary directories rather than a real machine.
 */

const fs = require("node:fs");
const path = require("node:path");

const UNIT_NAME = "gmweb-api.service";
const DROPIN_DIR_NAME = `${UNIT_NAME}.d`;
const DROPIN_FILE_NAME = "10-gmweb-public-origin.conf";

function unitPath(root) {
  return path.join(root, "etc", "systemd", "system", UNIT_NAME);
}

function dropinPath(root) {
  return path.join(root, "etc", "systemd", "system", DROPIN_DIR_NAME, DROPIN_FILE_NAME);
}

function dropinDir(root) {
  return path.join(root, "etc", "systemd", "system", DROPIN_DIR_NAME);
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Unquote a systemd value: `"x y"`, `'x y'` and bare values are all legal. */
function unquote(value) {
  const trimmed = String(value).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  // systemd treats an unquoted value as running to end of line, then trims.
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/**
 * Parse `Environment=` and `EnvironmentFile=` directives from one unit fragment.
 *
 * Only the `[Service]` section is considered: an `Environment=` line in `[Unit]` is not a
 * thing systemd applies to the process, and pretending otherwise would produce a
 * confidently wrong "effective environment".
 */
function parseUnitFragment(text) {
  const environment = {};
  const environmentFiles = [];
  if (!text) return { environment, environmentFiles };

  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== "Service") continue;

    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assign) continue;
    const key = assign[1];
    const value = assign[2];

    if (key === "Environment") {
      // `Environment=A=1 B=2` and repeated lines are both valid; split on unquoted spaces.
      for (const pair of splitAssignments(value)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        environment[pair.slice(0, eq)] = unquote(pair.slice(eq + 1));
      }
      continue;
    }
    if (key === "EnvironmentFile") {
      const parts = splitAssignments(value);
      for (const part of parts) {
        let spec = unquote(part);
        let optional = false;
        if (spec.startsWith("-")) {
          optional = true;
          spec = spec.slice(1);
        }
        if (spec) environmentFiles.push({ path: spec, optional });
      }
    }
  }
  return { environment, environmentFiles };
}

/** Split `A=1 B="c d"` into assignments without breaking quoted values. */
function splitAssignments(value) {
  const out = [];
  let current = "";
  let quote = null;
  for (const char of String(value)) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The environment systemd will hand the service, in application order:
 * the main unit, then drop-ins sorted the way systemd sorts them (lexicographically by
 * filename), then the referenced EnvironmentFiles in the order declared.
 *
 * Later assignments win, which is what makes a drop-in an effective override.
 */
function effectiveServiceEnvironment(root) {
  const fragments = [];
  const main = readIfPresent(unitPath(root));
  if (main !== null) fragments.push({ label: UNIT_NAME, text: main });

  let dropins = [];
  try {
    dropins = fs.readdirSync(dropinDir(root)).filter((name) => name.endsWith(".conf")).sort();
  } catch {
    dropins = [];
  }
  for (const name of dropins) {
    const text = readIfPresent(path.join(dropinDir(root), name));
    if (text !== null) fragments.push({ label: `${DROPIN_DIR_NAME}/${name}`, text });
  }

  const environment = {};
  const environmentFiles = [];
  const order = [];
  for (const fragment of fragments) {
    const parsed = parseUnitFragment(fragment.text);
    order.push(fragment.label);
    Object.assign(environment, parsed.environment);
    for (const file of parsed.environmentFiles) environmentFiles.push(file);
  }

  // EnvironmentFile values are applied by systemd AFTER the unit's own Environment=.
  const fileValues = {};
  const fileSources = {};
  for (const file of environmentFiles) {
    const absolute = path.isAbsolute(file.path) ? file.path : path.join(root, file.path);
    const text = readIfPresent(absolute);
    if (text === null) {
      if (!file.optional) {
        fileSources[absolute] = "<missing>";
      }
      continue;
    }
    const parsed = parseEnvText(text);
    for (const [key, value] of Object.entries(parsed)) {
      fileValues[key] = value;
      fileSources[key] = absolute;
    }
  }
  Object.assign(environment, fileValues);

  return {
    environment,
    unitsRead: order,
    environmentFiles,
    environmentFileMissing: Object.values(fileSources).includes("<missing>"),
    fileSources,
  };
}

/**
 * Parse a dotenv-style file. Intentionally conservative: only `KEY=value` lines, for the
 * keys asked about, so a malformed line can never be mistaken for a configured origin.
 */
function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip an inline comment only when it is preceded by whitespace, so a value that
    // legitimately contains '#' is preserved.
    value = value.replace(/\s+#.*$/, "");
    out[key] = unquote(value);
  }
  return out;
}

function readEnvFileValues(file) {
  return parseEnvText(readIfPresent(file));
}

/** Read one key from an environment file, or undefined. */
function readEnvFileValue(file, key) {
  const values = readEnvFileValues(file);
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
}

/**
 * Set `KEY=value` in a dotenv file idempotently.
 *
 * Guarantees relied on by the tests:
 *  - an existing KEY is replaced in place, whatever spacing or quoting it had;
 *  - unrelated lines (including comments and blank lines) are byte-preserved;
 *  - repeated calls produce a byte-identical file, so a re-run never appends duplicates;
 *  - the file is written through a temp file + rename, so a crash cannot truncate the
 *    live configuration that the running service still depends on.
 */
function setEnvFileValue(file, key, value) {
  const existing = readIfPresent(file);
  const hadTrailingNewline = existing === null || existing === "" || existing.endsWith("\n");
  const lines = existing === null ? [] : existing.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const rendered = `${key}=${value}`;
  let replaced = false;
  const next = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1] === key) {
      if (replaced) return null; // drop duplicates; the first occurrence wins
      replaced = true;
      return rendered;
    }
    return line;
  }).filter((line) => line !== null);

  if (!replaced) next.push(rendered);
  const body = `${next.join("\n")}\n`;
  const finalText = hadTrailingNewline || !existing ? body : body.slice(0, -1);

  if (existing === finalText) return { changed: false, file };

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  // Preserve the existing mode; .env holds the API token and is 0600 in production. The mode
  // is applied with an explicit chmod because the process umask strips bits from a create-time
  // mode, which would quietly broaden permissions on the file that holds a credential.
  const mode = (() => {
    try {
      return fs.statSync(file).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  fs.writeFileSync(tmp, finalText, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return { changed: true, file };
}

/**
 * Ensure the service loads an environment file, WITHOUT touching unrelated overrides.
 *
 * Preference order:
 *  1. the existing unit or drop-ins already load this exact file -> nothing to do;
 *  2. append an `EnvironmentFile=` line to our own dedicated drop-in, preserving whatever
 *     else that drop-in contains;
 *  3. create the drop-in.
 *
 * A drop-in is used rather than rewriting the unit because the unit is generated by two
 * different installers and may have been edited by an operator; a drop-in is additive,
 * reversible and does not disturb anything else in it.
 */
function ensureServiceLoadsEnvironmentFile(root, envFilePath) {
  const effective = effectiveServiceEnvironment(root);
  const already = effective.environmentFiles.some((file) => {
    const absolute = path.isAbsolute(file.path) ? file.path : path.join(root, file.path);
    return absolute === envFilePath;
  });
  if (already) {
    return { changed: false, reason: "already-loaded", dropin: null, daemonReloadRequired: false };
  }

  const file = dropinPath(root);
  const existing = readIfPresent(file);
  if (existing !== null) {
    // Another drop-in already sets a non-optional EnvironmentFile for the same variables.
    // Adding ours after it wins for the variables we own, and we never remove theirs.
    if (!/^\s*EnvironmentFile\s*=/m.test(existing)) {
      const ensured = setEnvFileValue(file, "EnvironmentFile", `-${envFilePath}`);
      return { changed: ensured.changed, reason: "appended", dropin: file, daemonReloadRequired: ensured.changed };
    }
    // The drop-in already declares an EnvironmentFile; if it is a different file, write a
    // second drop-in so ours still applies (systemd applies both, later one wins).
    const second = path.join(dropinDir(root), "20-gmweb-public-origin.conf");
    const secondExisting = readIfPresent(second);
    if (secondExisting !== null) {
      return { changed: false, reason: "dropin-present", dropin: second, daemonReloadRequired: false };
    }
    fs.mkdirSync(path.dirname(second), { recursive: true });
    writeAtomic(second, `# Managed by GMweb public-origin preflight.\n[Service]\nEnvironmentFile=-${envFilePath}\n`);
    return { changed: true, reason: "second-dropin", dropin: second, daemonReloadRequired: true };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(
    file,
    [
      "# Managed by GMweb public-origin preflight (scripts/publicOriginPreflight.js).",
      "#",
      "# The API reads PUBLIC_WEB_ORIGIN / PUBLIC_API_ORIGIN from the process environment and",
      "# ADR-007 refuses to start in production without them. Declaring the canonical env file",
      "# here makes systemd hand those values to the process directly, instead of relying on",
      "# dotenv resolving a path relative to the service working directory.",
      "[Service]",
      `EnvironmentFile=-${envFilePath}`,
      "",
    ].join("\n")
  );
  return { changed: true, reason: "created", dropin: file, daemonReloadRequired: true };
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function dropinContent(root) {
  return readIfPresent(dropinPath(root));
}

module.exports = {
  UNIT_NAME,
  DROPIN_DIR_NAME,
  DROPIN_FILE_NAME,
  unitPath,
  dropinPath,
  dropinDir,
  parseUnitFragment,
  parseEnvText,
  splitAssignments,
  readEnvFileValues,
  readEnvFileValue,
  setEnvFileValue,
  effectiveServiceEnvironment,
  ensureServiceLoadsEnvironmentFile,
  dropinContent,
};
