export interface PairingDiagnostic {
  id: string;
  ts: string;
  level: "info" | "warning" | "error";
  title: string;
  path: string;
  statusCode: number;
  details?: {
    pairing?: {
      stage?: string;
      status?: string;
      reason?: string | null;
      sessionIdHash?: string | null;
      deviceIdHash?: string | null;
    };
  };
}

async function responseError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: string; reason?: string; retryAfterSeconds?: number };
  if (res.status === 429) {
    return new Error(`Too many attempts. Try again in ${body.retryAfterSeconds || 60} seconds.`);
  }
  const detail = [body.error, body.reason].filter(Boolean).join(" / ");
  return new Error(detail || `HTTP ${res.status}`);
}

export async function loginWithAdminToken(token: string): Promise<void> {
  const res = await fetch("/api/v1/pwa/token-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw await responseError(res);
}

export async function fetchPairingDiagnostics(limit = 30): Promise<PairingDiagnostic[]> {
  const res = await fetch(`/api/v1/pairing/diagnostics?limit=${limit}`, { credentials: "include" });
  if (!res.ok) throw await responseError(res);
  const body = await res.json() as { logs?: PairingDiagnostic[] };
  return Array.isArray(body.logs) ? body.logs : [];
}
