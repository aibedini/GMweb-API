import { useEffect, useState } from "react";
import { syncNow, listRecentEvents, getCursor, resetLocal, type StoredEvent } from "../lib/sync";
import { fetchTrustSnapshot, health, type TrustSnapshot } from "../lib/api";

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

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <h1 className="text-lg font-semibold">Messages</h1>
        <span className="text-xs" style={{ color: "var(--muted-fg)" }}>
          GMweb {version}
        </span>
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
              web-01 shell · sync + trust surfaces live · passkeys/Inbox/SSE land in
              Phase 4 per TechSpec §5 — payloads stay opaque until the Phase 7 crypto review.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
