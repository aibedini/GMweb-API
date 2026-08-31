import { useEffect, useState } from "react";
import {
  fetchAuthStatus,
  passkeyLogin,
  passkeyRegister,
  webAuthnSupported,
  type AuthStatus,
} from "../lib/auth";

/**
 * web-03 (§21/§85): Passkey-first login. The primary CTA follows the
 * server-declared next step (registration on first run, authentication after).
 * No password field exists — §21: password-only is not offered.
 */
export default function LoginScreen({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(webAuthnSupported());

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await fetchAuthStatus());
      } catch (e) {
        setError(e instanceof Error ? e.message : "unreachable");
      }
    })();
  }, []);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!status) return;
      if (status.next === "registration") await passkeyRegister();
      else await passkeyLogin();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel = !status
    ? "Checking…"
    : status.next === "registration"
      ? "Set up this device (passkey)"
      : "Continue with Passkey";

  return (
    <div className="mx-auto flex h-full max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">Messages</h1>
      <p className="mt-2 text-sm" style={{ color: "var(--muted-fg)" }}>
        Secure sign-in with your device. No password — your fingerprint, face,
        or device PIN unlocks this account (§21).
      </p>

      {!supported && (
        <div className="mt-6 rounded-lg border p-3 text-xs" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          This browser does not support WebAuthn. Use a modern browser over HTTPS.
        </div>
      )}

      <button
        onClick={() => void go()}
        disabled={busy || !status || !supported}
        className="mt-6 rounded-lg px-4 py-3 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--accent)", color: "white" }}
      >
        {busy ? "Waiting for authenticator…" : primaryLabel}
      </button>

      <div className="my-4 flex items-center gap-2 text-xs" style={{ color: "var(--muted-fg)" }}>
        <span className="h-px flex-1" style={{ background: "var(--border)" }} />
        or
        <span className="h-px flex-1" style={{ background: "var(--border)" }} />
      </div>
      <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
        Fallback (TOTP / recovery) lands with the Security Center screens — the
        passkey remains the primary path (§21 ordering).
      </p>

      {error && (
        <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
