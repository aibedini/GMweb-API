import { useEffect, useState } from "react";
import { syncNow, listRecentEvents, getCursor, resetLocal, subscribeSyncAvailable, type StoredEvent } from "../lib/sync";
import { fetchTrustSnapshot, health, type TrustSnapshot } from "../lib/api";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  removeSubscriptionFromServer,
} from "../lib/push";
import { fetchAuthStatus, type AuthStatus } from "../lib/auth";
import LoginScreen from "../screens/LoginScreen";

/**
 * web-01 shell (TechSpec §5 Phase 4 start): three honest screens —
 *   Sync   (cursor status + pull now + recent opaque events)
 *   Trust  (Android-signed snapshot: root key + trustSequence)
 *   Debug  (health, local reset)
 * Login/Inbox land with Phase 4 proper (passkeys + §7 screens); everything
 * shown here is ALREADY live on the control plane.
 */
type Tab = "sync" | "trust" | "debug";

export default function App() {
  const [tab, setTab] = useState<Tab>("sync");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustSnapshot | null>(null);
  const [version, setVersion] = useState<string>("");
  const [pushState, setPushState] = useState<string>("");
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking

  // Passkey-first gate (§33/§34): /api/v1/auth/* is public, so the login
  // screen can decide enroll-vs-authenticate. Everything else behind the
  // session cookie issued by the passkey ceremony.
  useEffect(() => {
    void (async () => {
      try {
        const s = await fetchAuthStatus();
        setAuthStatus(s);
        // If no passkey exists yet → show login (bootstrap). If configured →
        // still show login; the session cookie will be issued by the ceremony.
        // (API calls in Sync/Trust tabs work once authed; pre-auth they show
        // honest errors.)
        setAuthed(false);
      } catch {
        setAuthStatus(null);
        setAuthed(false);
      }
    })();
  }, []);

  const refresh = async () => {
    setCursor(await getCursor());
    setEvents(await listRecentEvents(50));
    setTrust(await fetchTrustSnapshot());
  };

  useEffect(() => {
    void (async () => {
      try {
        setVersion((await health()).version);
      } catch {
        setVersion("unreachable");
      }
      await refresh();
    })();
    // §44: realtime invalidation — the SSE signal is narrow (no content);
    // the durable cursor sync does the actual catching up.
    const dispose = subscribeSyncAvailable((applied) => {
      setApplied(applied);
      void refresh();
    });
    return dispose;
  }, []);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await syncNow();
      setApplied(n);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Passkey gate: show LoginScreen until a passkey ceremony completes.
  if (authed === false && authStatus) {
    return <LoginScreen onDone={() => setAuthed(true)} />;
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <h1 className="text-lg font-semibold">Messages</h1>
        <div className="flex items-center gap-3">
          {authStatus?.passkeyConfigured && (
            <button
              onClick={() => setAuthed(false)}
              className="text-xs"
              style={{ color: "var(--muted-fg)" }}
              title="Lock the session and return to sign-in"
            >
              Lock
            </button>
          )}
          <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
            GMweb {version}
          </span>
        </div>
      </header>

      <nav className="flex gap-1 px-4 py-2">
        {(["sync", "trust", "debug"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="rounded-md px-3 py-1.5 text-sm capitalize"
            style={
              tab === t
                ? { background: "var(--accent)", color: "white" }
                : { color: "var(--muted-fg)" }
            }
          >
            {t}
          </button>
        ))}
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {tab === "sync" && (
          <section className="space-y-3">
            <div className="rounded-xl border p-4" style={{ background: "var(--card)", borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Cursor sync (§54)</p>
                  <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
                    local cursor: <code>{cursor}</code> — opaque ciphertext events
                  </p>
                </div>
                <button
                  onClick={pull}
                  disabled={busy}
                  className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                  style={{ background: "var(--accent)", color: "white" }}
                >
                  {busy ? "Syncing…" : "Sync now"}
                </button>
              </div>
              {applied !== null && (
                <p className="mt-2 text-xs" style={{ color: "var(--ok)" }}>
                  applied {applied} event(s) transactionally
                </p>
              )}
              {error && (
                <p className="mt-2 text-xs" style={{ color: "var(--danger)" }}>
                  {error}
                </p>
              )}
            </div>

            <ul className="space-y-2">
              {events.map((ev) => (
                <li
                  key={ev.sequence}
                  className="rounded-lg border px-3 py-2 text-xs"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold">#{ev.sequence}</span>
                    <span style={{ color: "var(--muted-fg)" }}>{ev.type}</span>
                  </div>
                  <div className="mt-1 truncate font-mono" style={{ color: "var(--muted-fg)" }} title={ev.ciphertext}>
                    {ev.ciphertext.slice(0, 44)}…
                  </div>
                </li>
              ))}
              {events.length === 0 && (
                <li className="rounded-lg border border-dashed p-6 text-center text-sm" style={{ color: "var(--muted-fg)", borderColor: "var(--border)" }}>
                  No events yet — send one from the Android agent, then Sync now.
                </li>
              )}
            </ul>
          </section>
        )}

        {tab === "trust" && (
          <section className="rounded-xl border p-4" style={{ background: "var(--card)", borderColor: "var(--border)" }}>
            <p className="text-sm font-medium">Signed Trust Registry (ADR-001)</p>
            {!trust && (
              <p className="mt-2 text-xs" style={{ color: "var(--muted-fg)" }}>
                No snapshot yet — the Android trust root has not published one.
              </p>
            )}
            {trust && (
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt style={{ color: "var(--muted-fg)" }}>trustSequence</dt>
                  <dd className="font-mono">{trust.trustSequence}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt style={{ color: "var(--muted-fg)" }}>rootPublicKey</dt>
                  <dd className="truncate font-mono" title={trust.rootPublicKey}>
                    {trust.rootPublicKey.slice(0, 24)}…
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt style={{ color: "var(--muted-fg)" }}>updatedAt</dt>
                  <dd className="font-mono">{new Date(trust.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>
            )}
          </section>
        )}

        {tab === "debug" && (
          <section className="space-y-3">
            <div className="rounded-xl border p-4 text-sm" style={{ background: "var(--card)", borderColor: "var(--border)" }}>
              <p className="font-medium">Web Push (§45)</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                Content-less wake-ups only (§30 default): notifications say
                «N new events — open to sync» and never carry message content.
                Permission is requested only by this explicit click.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() =>
                    void (async () => {
                      setPushState("…");
                      try {
                        if (!pushSupported()) {
                          setPushState("unsupported browser");
                          return;
                        }
                        const res = await fetch("/api/v1/push/public-key");
                        const { publicKey } = (await res.json()) as { publicKey: string };
                        const sub = await subscribeToPush(publicKey);
                        if (!sub) {
                          setPushState("permission denied / unsupported");
                          return;
                        }
                        const ok = await import("../lib/push").then((m) => m.sendSubscriptionToServer(sub));
                        setPushState(ok ? "subscribed ✓" : "subscribe upload failed");
                      } catch (e) {
                        setPushState(e instanceof Error ? e.message : "error");
                      }
                    })()
                  }
                  className="rounded-md px-3 py-1.5 text-xs"
                  style={{ background: "var(--accent)", color: "white" }}
                >
                  Enable push
                </button>
                <button
                  onClick={() =>
                    void (async () => {
                      const reg = await navigator.serviceWorker?.getRegistration("/web/");
                      const sub = await reg?.pushManager.getSubscription();
                      if (sub) {
                        await removeSubscriptionFromServer(sub.endpoint);
                        await unsubscribeFromPush();
                      }
                      setPushState("unsubscribed");
                    })()
                  }
                  className="rounded-md px-3 py-1.5 text-xs"
                  style={{ border: "1px solid var(--border)", color: "var(--muted-fg)" }}
                >
                  Disable
                </button>
              </div>
              {pushState && (
                <p className="mt-2 text-xs" style={{ color: "var(--ok)" }}>
                  {pushState}
                </p>
              )}
            </div>
            <div className="rounded-xl border p-4 text-sm" style={{ background: "var(--card)", borderColor: "var(--border)" }}>
              <p className="font-medium">Local store</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted-fg)" }}>
                IndexedDB «gmweb-messages» — events + cursor. Reset re-syncs from zero
                (server sequences are the truth; nothing is lost).
              </p>
              <button
                onClick={() => void (async () => { await resetLocal(); await refresh(); setApplied(null); })()}
                className="mt-3 rounded-md px-3 py-1.5 text-xs"
                style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}
              >
                Reset local cache
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
              web-01 shell · sync + SSE + trust + push surfaces live · passkeys/Inbox land in
              Phase 4 per TechSpec §5 — payloads stay opaque until the Phase 7 crypto review.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
