/**
 * web-05 (§84) — Security Center data layer.
 * Wraps the already-live control-plane endpoints into typed calls the
 * Security tab renders. No new server surface needed: everything here ships
 * in v0.8.0 (passkeys) / v0.10.0 (agent identities).
 */

export interface CredentialRow {
  credentialId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface IdentityRow {
  device_id: string;
  registered_at: number;
  protocol_version: number;
}

/** §84 Security Center — enrolled passkeys (requires authed session). */
export async function listCredentials(): Promise<CredentialRow[]> {
  const res = await fetch("/api/v1/auth/credentials");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { credentials: CredentialRow[] };
  return body.credentials;
}

/** §24 step-up: remove requires the current authenticated session. */
export async function removeCredential(credentialId: string): Promise<void> {
  const res = await fetch("/api/v1/auth/credentials/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentialId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** ADR-004/PR-08b: enrolled Android agent identities. */
export async function listAgentIdentities(): Promise<IdentityRow[]> {
  const res = await fetch("/api/v1/agent/identities");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { identities: IdentityRow[] };
  return body.identities;
}

/** §89: registered push subscriptions (endpoint hashes truncated server-side). */
export async function listPushSubscriptions(): Promise<{ count: number }> {
  const res = await fetch("/api/v1/push/subscriptions");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Session state probe: a 200 on credentials means the cookie is live. */
export async function isSessionLive(): Promise<boolean> {
  try {
    const res = await fetch("/api/v1/auth/credentials");
    return res.ok;
  } catch {
    return false;
  }
}
