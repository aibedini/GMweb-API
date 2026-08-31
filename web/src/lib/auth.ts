/**
 * web-03 (§21) — Passkey-first client flow (@simplewebauthn/browser).
 * Mirrors the server routes: status → register (bootstrap) OR authenticate.
 */

import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export interface AuthStatus {
  passkeyConfigured: boolean;
  next: "registration" | "authentication";
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/v1/auth/status");
  if (!res.ok) throw new Error(`auth status HTTP ${res.status}`);
  return res.json();
}

export function webAuthnSupported(): boolean {
  return browserSupportsWebAuthn();
}

/** Bootstrap enrollment (first run) or adding a passkey from an authed session. */
export async function passkeyRegister(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/v1/auth/passkey/register/options");
  if (!res.ok) throw new Error(`options HTTP ${res.status}`);
  const options = await res.json();
  const attestation = await startRegistration({ optionsJSON: options });
  const verify = await fetch("/api/v1/auth/passkey/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attestation),
  });
  if (!verify.ok) {
    const body = await verify.json().catch(() => ({ error: verify.statusText }));
    throw new Error(body.error || `verify HTTP ${verify.status}`);
  }
  return verify.json();
}

/** Daily sign-in: assertion → server sets the session cookie. */
export async function passkeyLogin(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/v1/auth/passkey/auth/options");
  if (!res.ok) throw new Error(`options HTTP ${res.status}`);
  const options = await res.json();
  const assertion = await startAuthentication({ optionsJSON: options });
  const verify = await fetch("/api/v1/auth/passkey/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assertion),
  });
  if (!verify.ok) {
    const body = await verify.json().catch(() => ({ error: verify.statusText }));
    throw new Error(body.error || `verify HTTP ${verify.status}`);
  }
  return verify.json();
}
